import { Injectable } from '@nestjs/common';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { DataSource, EntityManager } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { parsePositiveInt } from '../common/env-parsing.js';
import type { MutationTx } from './vfs-node.repository.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsMutationReceiptEntity } from './entities/vfs-mutation-receipt.entity.js';

export interface ReceiptIdentity {
  readonly namespaceId: string;
  readonly scope: string;
  readonly key: string;
}

export interface ReceiptResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export type ReceiptClaim =
  | { readonly kind: 'owner'; readonly generation: number }
  | { readonly kind: 'complete'; readonly receipt: VfsMutationReceiptEntity }
  | { readonly kind: 'busy'; readonly retryAfterSeconds: number };

const RECEIPT_DAYS = 30;

export function mutationLeaseSeconds(): number {
  return parsePositiveInt(process.env.STORIX_MUTATION_LEASE_SECONDS, 60);
}

function expiresAfter(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

function keyOf(
  identity: ReceiptIdentity,
): Pick<VfsMutationReceiptEntity, 'namespaceId' | 'scope' | 'idempotencyKey'> {
  return { namespaceId: identity.namespaceId, scope: identity.scope, idempotencyKey: identity.key };
}

@Injectable()
export class VfsMutationReceiptRepository {
  constructor(private readonly dataSource: DataSource) {}

  private get repo() {
    return this.dataSource.getRepository(VfsMutationReceiptEntity);
  }

  @classifyPersistenceOperation
  async claim(identity: ReceiptIdentity, now: Date): Promise<ReceiptClaim> {
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const leaseMs = mutationLeaseSeconds() * 1000;
    const toSqlTime = (date: Date): string =>
      sqlite ? date.toISOString().replace('T', ' ').replace('Z', '') : date.toISOString();
    const params = [
      identity.namespaceId,
      identity.scope,
      identity.key,
      toSqlTime(expiresAfter(now, leaseMs)),
      toSqlTime(expiresAfter(now, RECEIPT_DAYS * 86400_000)),
    ];
    const placeholders = params.map((_, index) => (sqlite ? '?' : `$${index + 1}`));
    const inserted: { generation: number }[] = await this.dataSource.query(
      `
      INSERT INTO vfs_mutation_receipt
        (namespace_id, scope, idempotency_key, state, generation, lease_expires_at, expires_at)
      VALUES (${placeholders[0]}, ${placeholders[1]}, ${placeholders[2]}, 'RESERVED', 1, ${placeholders[3]}, ${placeholders[4]})
      ON CONFLICT (namespace_id, scope, idempotency_key) DO NOTHING
      RETURNING generation
    `,
      params,
    );
    if (inserted.length > 0) return { kind: 'owner', generation: 1 };

    const expiredClaim = await this.repo
      .createQueryBuilder()
      .update(VfsMutationReceiptEntity)
      .set({
        generation: () => 'generation + 1',
        leaseExpiresAt: expiresAfter(now, leaseMs),
        updatedAt: now,
      })
      .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
      .andWhere("state = 'RESERVED' AND lease_expires_at <= :now", { now })
      .execute();
    if (expiredClaim.affected === 1) {
      const row = await this.repo.findOneByOrFail(keyOf(identity));
      return { kind: 'owner', generation: row.generation };
    }

    const row = await this.repo.findOneByOrFail(keyOf(identity));
    if (row.state === 'COMPLETE') {
      if (row.expiresAt <= now) {
        await this.repo
          .createQueryBuilder()
          .delete()
          .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
          .andWhere("state = 'COMPLETE' AND expires_at <= :now", { now })
          .execute();
        return this.claim(identity, now);
      }
      return { kind: 'complete', receipt: row };
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((row.leaseExpiresAt?.getTime() ?? now.getTime()) - now.getTime()) / 1000),
    );
    return { kind: 'busy', retryAfterSeconds };
  }

  @classifyPersistenceOperation
  async renew(identity: ReceiptIdentity, generation: number, now: Date): Promise<boolean> {
    const leaseMs = mutationLeaseSeconds() * 1000;
    const result = await this.repo
      .createQueryBuilder()
      .update(VfsMutationReceiptEntity)
      .set({ leaseExpiresAt: expiresAfter(now, leaseMs), updatedAt: now })
      .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
      .andWhere("state = 'RESERVED' AND generation = :generation AND lease_expires_at > :now", {
        generation,
        now,
      })
      .execute();
    return result.affected === 1;
  }

  @classifyPersistenceOperation
  async complete(
    tx: MutationTx,
    identity: ReceiptIdentity,
    generation: number,
    fingerprint: string,
    method: string,
    response: ReceiptResponse,
    requestBodyBytes?: number,
  ): Promise<void> {
    await this.completeWith(
      tx.manager,
      identity,
      generation,
      fingerprint,
      method,
      response,
      requestBodyBytes,
    );
  }

  // 작업 트랜잭션이 롤백된 뒤 오류 응답을 확정하는 경로다. 롤백된(PostgreSQL에서는
  // abort된) 트랜잭션을 재사용할 수 없으므로 새 짧은 트랜잭션을 연다. fencing 조건과
  // 저장 필드는 complete와 같다.
  @classifyPersistenceOperation
  async completeAfterRollback(
    identity: ReceiptIdentity,
    generation: number,
    fingerprint: string,
    method: string,
    response: ReceiptResponse,
    requestBodyBytes?: number,
  ): Promise<void> {
    await this.dataSource.transaction((manager) =>
      this.completeWith(manager, identity, generation, fingerprint, method, response, requestBodyBytes),
    );
  }

  @classifyPersistenceOperation
  async namespaceExists(namespaceId: string): Promise<boolean> {
    return (await this.dataSource.getRepository(NamespaceEntity).findOneBy({ id: namespaceId })) !== null;
  }

  // 보존 기한은 claim 시점이 아니라 완료 시점부터 RECEIPT_DAYS다.
  // generation과 미만료 lease가 모두 맞는 owner만 완료할 수 있다.
  private async completeWith(
    manager: EntityManager,
    identity: ReceiptIdentity,
    generation: number,
    fingerprint: string,
    method: string,
    response: ReceiptResponse,
    requestBodyBytes: number | undefined,
  ): Promise<void> {
    const now = new Date();
    const result = await manager
      .getRepository(VfsMutationReceiptEntity)
      .createQueryBuilder()
      .update(VfsMutationReceiptEntity)
      .set({
        state: 'COMPLETE',
        leaseExpiresAt: null,
        expiresAt: expiresAfter(now, RECEIPT_DAYS * 86400_000),
        method,
        fingerprint,
        responseStatus: response.status,
        responseBody: JSON.stringify(response.body),
        responseHeaders: JSON.stringify(response.headers),
        requestBodyBytes: requestBodyBytes === undefined ? null : String(requestBodyBytes),
        updatedAt: now,
      })
      .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
      .andWhere("state = 'RESERVED' AND generation = :generation AND lease_expires_at > :now", {
        generation,
        now,
      })
      .execute();
    if (result.affected !== 1) throw new Error('VFS mutation claim lost');
  }

  @classifyPersistenceOperation
  async release(identity: ReceiptIdentity, generation: number): Promise<void> {
    await this.repo.delete({ ...keyOf(identity), state: 'RESERVED', generation });
  }

  @classifyPersistenceOperation
  async pruneExpired(now: Date): Promise<number> {
    const expired = await this.repo
      .createQueryBuilder('r')
      .where("r.state = 'COMPLETE' AND r.expires_at <= :now", { now })
      .orderBy('r.expires_at', 'ASC')
      .take(500)
      .getMany();
    for (const row of expired) {
      await this.repo
        .createQueryBuilder()
        .delete()
        .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', {
          namespaceId: row.namespaceId,
          scope: row.scope,
          key: row.idempotencyKey,
        })
        .andWhere("state = 'COMPLETE' AND expires_at <= :now", { now })
        .execute();
    }
    return expired.length;
  }
}
