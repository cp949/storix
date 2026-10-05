import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { classifyPersistenceOperation } from './persistence-failure.js';
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
// 재조회 사이에 다른 요청이 행을 지우는 경합에서 claim을 다시 시도하는 최대 횟수다.
const MAX_CLAIM_ATTEMPTS = 3;

export function mutationLeaseSeconds(): number {
  return parsePositiveInt(process.env.STORIX_MUTATION_LEASE_SECONDS, 60);
}

function expiresAfter(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

function databaseNowExpression(sqlite: boolean): string {
  return sqlite ? "strftime('%Y-%m-%d %H:%M:%f', 'now')" : 'clock_timestamp()';
}

function databaseExpiryExpression(sqlite: boolean, seconds: string): string {
  return sqlite
    ? `strftime('%Y-%m-%d %H:%M:%f', 'now', '+' || ${seconds} || ' seconds')`
    : `(clock_timestamp() + (${seconds} * INTERVAL '1 second'))`;
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

  /**
   * claim을 얻거나 기존 상태를 돌려준다. INSERT·takeover·재조회가 한 트랜잭션이 아니라서
   * 그 사이에 release·pruneExpired·namespace 삭제가 행을 지울 수 있다. 행이 사라지면
   * 처음부터 다시 시도하고, 상한을 넘으면 다른 요청이 경합 중인 것과 같게 busy로 응답한다.
   */
  @classifyPersistenceOperation
  async claim(identity: ReceiptIdentity, now: Date): Promise<ReceiptClaim> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const claim = await this.tryClaim(identity, now);
      if (claim) return claim;
    }
    return { kind: 'busy', retryAfterSeconds: 1 };
  }

  // 재조회 시점에 행이 없거나 만료된 COMPLETE 행을 지웠다면 null이다. 호출자가 다시 시도한다.
  private async tryClaim(identity: ReceiptIdentity, now: Date): Promise<ReceiptClaim | null> {
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const leaseSeconds = mutationLeaseSeconds();
    const toSqlTime = (date: Date): string =>
      sqlite ? date.toISOString().replace('T', ' ').replace('Z', '') : date.toISOString();
    const leaseExpiry = databaseExpiryExpression(sqlite, sqlite ? '?' : '$4');
    const expiresAt = sqlite ? '?' : '$5';
    const params = [
      identity.namespaceId,
      identity.scope,
      identity.key,
      leaseSeconds,
      toSqlTime(expiresAfter(now, RECEIPT_DAYS * 86400_000)),
    ];
    const placeholders = params.map((_, index) => (sqlite ? '?' : `$${index + 1}`));
    const inserted: { generation: number }[] = await this.dataSource.query(
      `
      INSERT INTO vfs_mutation_receipt
        (namespace_id, scope, idempotency_key, state, generation, lease_expires_at, expires_at)
      VALUES (${placeholders[0]}, ${placeholders[1]}, ${placeholders[2]}, 'RESERVED', 1, ${leaseExpiry}, ${expiresAt})
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
        leaseExpiresAt: () => databaseExpiryExpression(sqlite, ':leaseSeconds'),
        updatedAt: () => databaseNowExpression(sqlite),
      })
      .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
      .andWhere(`state = 'RESERVED' AND lease_expires_at <= ${databaseNowExpression(sqlite)}`)
      .setParameter('leaseSeconds', leaseSeconds)
      .execute();
    if (expiredClaim.affected === 1) {
      const row = await this.repo.findOneBy(keyOf(identity));
      return row ? { kind: 'owner', generation: row.generation } : null;
    }

    const row = await this.repo.findOneBy(keyOf(identity));
    if (!row) return null;
    if (row.state === 'COMPLETE') {
      if (row.expiresAt <= now) {
        await this.repo
          .createQueryBuilder()
          .delete()
          .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
          .andWhere("state = 'COMPLETE' AND expires_at <= :now", { now })
          .execute();
        return null;
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
  async renew(identity: ReceiptIdentity, generation: number): Promise<boolean> {
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const result = await this.repo
      .createQueryBuilder()
      .update(VfsMutationReceiptEntity)
      .set({
        leaseExpiresAt: () => databaseExpiryExpression(sqlite, ':leaseSeconds'),
        updatedAt: () => databaseNowExpression(sqlite),
      })
      .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
      // 만료 시각만 지난 같은 generation owner는 아직 takeover되지 않았다면 갱신할 수 있다.
      // 동시 takeover가 먼저 이기면 generation이 바뀌어 이전 owner의 갱신은 계속 막힌다.
      .andWhere("state = 'RESERVED' AND generation = :generation", { generation })
      .setParameter('leaseSeconds', mutationLeaseSeconds())
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

  /** tombstone을 제외하고 데이터 요청을 허용하는 ACTIVE namespace만 확인한다. */
  @classifyPersistenceOperation
  async namespaceIsActive(namespaceId: string): Promise<boolean> {
    return (
      (await this.dataSource
        .getRepository(NamespaceEntity)
        .findOneBy({ id: namespaceId, status: 'ACTIVE' })) !== null
    );
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
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const result = await manager
      .getRepository(VfsMutationReceiptEntity)
      .createQueryBuilder()
      .update(VfsMutationReceiptEntity)
      .set({
        state: 'COMPLETE',
        leaseExpiresAt: null,
        expiresAt: () => databaseExpiryExpression(sqlite, ':receiptSeconds'),
        method,
        fingerprint,
        responseStatus: response.status,
        responseBody: JSON.stringify(response.body),
        responseHeaders: JSON.stringify(response.headers),
        requestBodyBytes: requestBodyBytes === undefined ? null : String(requestBodyBytes),
        updatedAt: () => databaseNowExpression(sqlite),
      })
      .where('namespace_id = :namespaceId AND scope = :scope AND idempotency_key = :key', identity)
      .andWhere(
        `state = 'RESERVED' AND generation = :generation AND lease_expires_at > ${databaseNowExpression(sqlite)}`,
        {
          generation,
        },
      )
      .setParameter('receiptSeconds', RECEIPT_DAYS * 86400)
      .execute();
    if (result.affected !== 1) throw new Error('VFS mutation claim lost');
  }

  @classifyPersistenceOperation
  async release(identity: ReceiptIdentity, generation: number): Promise<void> {
    await this.repo.delete({ ...keyOf(identity), state: 'RESERVED', generation });
  }

  /**
   * 보존 기한이 지난 receipt를 오래된 것부터 최대 500개 지운다.
   * - `COMPLETE`: 완료 시점부터 30일이 지난 행.
   * - `RESERVED`: claim 시점부터 30일이 지났고 lease도 만료된 행. 프로세스 종료로 버려졌는데
   *   같은 key의 재요청이 없는 claim이다. lease가 살아 있으면 owner가 갱신 중이라 남긴다.
   */
  @classifyPersistenceOperation
  async pruneExpired(now: Date): Promise<number> {
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const expiredCondition = `(state = 'COMPLETE' AND expires_at <= :now)
      OR (state = 'RESERVED' AND expires_at <= :now AND lease_expires_at <= ${databaseNowExpression(sqlite)})`;
    const expired = await this.repo
      .createQueryBuilder('r')
      .where(expiredCondition, { now })
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
        .andWhere(`(${expiredCondition})`, { now })
        .execute();
    }
    return expired.length;
  }
}
