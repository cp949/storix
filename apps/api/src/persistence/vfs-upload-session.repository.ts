import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNamespaceNotFoundError } from '../vfs/vfs.errors.js';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { VfsUploadPartEntity, type VfsUploadPartState } from './entities/vfs-upload-part.entity.js';
import { VfsUploadStagingCleanupEntity } from './entities/vfs-upload-staging-cleanup.entity.js';
import { VfsUploadSessionEntity, type VfsUploadSessionState } from './entities/vfs-upload-session.entity.js';
import { VfsUploadUsageEntity } from './entities/vfs-upload-usage.entity.js';

// staging_key 대조 질의 한 번에 넣는 key 수. SQLite 변수 제한을 피하려고 두 드라이버 모두 청크로 나눈다.
const KEY_LOOKUP_CHUNK_SIZE = 1000;

export interface UploadSessionCaps {
  readonly global: { readonly maxStagedBytes: bigint; readonly maxActiveSessions: number };
  readonly namespace: { readonly maxStagedBytes: bigint; readonly maxActiveSessions: number };
}

export interface CreateUploadSessionInput {
  readonly id: string;
  readonly namespaceId: string;
  readonly scope: string;
  readonly creationKey: string;
  readonly fingerprint: string;
  readonly targetPath: string;
  readonly sizeBytes: string;
  readonly sha256?: string | null;
  readonly mimeType: string;
  readonly conditionType: 'ABSENT' | 'REVISION';
  readonly conditionRevision: string | null;
  readonly fileExpiresInSeconds: number | null;
  readonly partSizeBytes: number;
  readonly partCount: number;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly maxExpiresAt: Date;
  readonly requestId?: string;
}

export type CreateUploadSessionResult =
  | { readonly kind: 'created' | 'replay'; readonly session: VfsUploadSessionEntity }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'limit' };

export type ReserveUploadPartResult =
  | { readonly kind: 'reserved'; readonly part: VfsUploadPartEntity }
  | { readonly kind: 'exists'; readonly part: VfsUploadPartEntity }
  | { readonly kind: 'limit' | 'closed' | 'invalid' | 'in-progress' };

interface UsageCounters {
  readonly id: string;
  readonly activeSessions: string;
  readonly stagedBytes: string;
}

@Injectable()
export class VfsUploadSessionRepository {
  constructor(private readonly dataSource: DataSource) {}

  // 모든 cap 변경은 global 다음 namespace 순서로 잠근다. SQLite는 연결 게이트가
  // 트랜잭션을 직렬화하고 PostgreSQL은 두 행의 FOR UPDATE가 인스턴스 간 순서를 고정한다.
  private async lockUsage(
    manager: EntityManager,
    namespaceId: string,
  ): Promise<[UsageCounters, UsageCounters]> {
    const namespaceKey = `ns:${namespaceId}`;
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const placeholder = sqlite ? '?' : '$1';
    const readLocked = async (id: string): Promise<UsageCounters> => {
      // SQLite bigint를 Number로 읽으면 2^53 이상에서 반올림된다. 양쪽 DB가
      // 정확한 10진 문자열을 반환하도록 CAST하고, PostgreSQL은 행을 잠근다.
      const rows = (await manager.query(
        `SELECT "id", CAST("active_sessions" AS TEXT) AS "activeSessions",
          CAST("staged_bytes" AS TEXT) AS "stagedBytes"
         FROM "vfs_upload_usage" WHERE "id" = ${placeholder}${sqlite ? '' : ' FOR UPDATE'}`,
        [id],
      )) as UsageCounters[];
      if (rows.length !== 1) throw new Error(`Upload usage row missing: ${id}`);
      return rows[0];
    };
    const global = await readLocked('global');
    await manager
      .createQueryBuilder()
      .insert()
      .into(VfsUploadUsageEntity)
      .values({ id: namespaceKey, namespaceId, activeSessions: '0', stagedBytes: '0' })
      .orIgnore()
      .execute();
    return [global, await readLocked(namespaceKey)];
  }

  /** root 잠금을 가진 삭제 접수가 기존 global → namespace usage 잠금을 공유한다. */
  async lockUsageForNamespace(manager: EntityManager, namespaceId: string): Promise<void> {
    await this.lockUsage(manager, namespaceId);
  }

  /** usage 잠금 뒤 비활성 namespace의 새 upload admission과 replay를 거부한다. */
  private async assertNamespaceActive(manager: EntityManager, namespaceId: string): Promise<void> {
    const namespace = await manager.getRepository(NamespaceEntity).findOne({
      select: { id: true, status: true },
      where: { id: namespaceId },
    });
    if (namespace?.status !== 'ACTIVE') throw new VfsNamespaceNotFoundError(namespaceId);
  }

  private async changeUsage(
    manager: EntityManager,
    rows: readonly UsageCounters[],
    field: 'activeSessions' | 'stagedBytes',
    amount: bigint,
  ): Promise<void> {
    const column = field === 'activeSessions' ? 'active_sessions' : 'staged_bytes';
    for (const row of rows) {
      await manager
        .createQueryBuilder()
        .update(VfsUploadUsageEntity)
        .set({ [field]: () => `${column} ${amount >= 0n ? '+' : '-'} ${amount >= 0n ? amount : -amount}` })
        .where('id = :id', { id: row.id })
        .execute();
    }
  }

  @classifyPersistenceOperation
  async createSession(
    input: CreateUploadSessionInput,
    caps: UploadSessionCaps,
  ): Promise<CreateUploadSessionResult> {
    return this.dataSource.transaction(async (manager) => {
      const usage = await this.lockUsage(manager, input.namespaceId);
      await this.assertNamespaceActive(manager, input.namespaceId);
      const repo = manager.getRepository(VfsUploadSessionEntity);
      const existing = await repo.findOneBy({
        namespaceId: input.namespaceId,
        scope: input.scope,
        creationKey: input.creationKey,
      });
      if (existing)
        return existing.fingerprint === input.fingerprint
          ? { kind: 'replay', session: existing }
          : { kind: 'conflict' };
      if (
        BigInt(usage[0].activeSessions) >= BigInt(caps.global.maxActiveSessions) ||
        BigInt(usage[1].activeSessions) >= BigInt(caps.namespace.maxActiveSessions)
      )
        return { kind: 'limit' };
      const session = repo.create({
        ...input,
        state: 'OPEN',
        leaseExpiresAt: null,
        leaseToken: null,
        terminalAt: null,
        responseStatus: null,
        responseBody: null,
        lastCompleteFailureCode: null,
        lastCompleteFailureAt: null,
        requestId: input.requestId ?? null,
        creationRequestId: input.requestId ?? null,
        createdAt: input.now,
        updatedAt: input.now,
        creationExpiresAt: input.expiresAt,
      });
      await repo.insert(session);
      await this.changeUsage(manager, usage, 'activeSessions', 1n);
      return { kind: 'created', session };
    });
  }

  @classifyPersistenceOperation
  async reservePart(
    sessionId: string,
    partIndex: number,
    sizeBytes: string,
    stagingKey: string,
    caps: UploadSessionCaps,
    leaseSeconds = 60,
  ): Promise<ReserveUploadPartResult> {
    const amount = BigInt(sizeBytes);
    if (amount <= 0n || !Number.isSafeInteger(partIndex) || partIndex < 0) return { kind: 'invalid' };
    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(VfsUploadSessionEntity);
      const session = await sessions.findOneBy({ id: sessionId });
      if (!session || session.state !== 'OPEN') return { kind: 'closed' };
      const usage = await this.lockUsage(manager, session.namespaceId);
      await this.assertNamespaceActive(manager, session.namespaceId);
      // Lock 대기 중 cancel/expire가 커밋됐을 수 있으므로 상태를 다시 읽는다.
      const current = await sessions.findOneBy({ id: sessionId });
      const now = new Date();
      if (!current || current.state !== 'OPEN' || current.expiresAt <= now || current.maxExpiresAt <= now)
        return { kind: 'closed' };
      const parts = manager.getRepository(VfsUploadPartEntity);
      const existing = await parts.findOneBy({ sessionId, partIndex });
      if (existing && (existing.state !== 'DELETED' || existing.objectDeletedAt === null))
        return { kind: 'exists', part: existing };
      const pendingDeletes = await manager
        .getRepository(VfsUploadStagingCleanupEntity)
        .countBy({ sessionId, partIndex, deletedAt: IsNull() });
      if (pendingDeletes !== 0) return { kind: 'in-progress' };
      // 삭제된 행을 교체해도 같은 객체 key를 재사용하면 과거 GC 콜백과 구별할 수 없다.
      if (existing?.stagingKey === stagingKey) return { kind: 'invalid' };
      if (partIndex >= session.partCount) return { kind: 'invalid' };
      if (
        BigInt(usage[0].stagedBytes) + amount > caps.global.maxStagedBytes ||
        BigInt(usage[1].stagedBytes) + amount > caps.namespace.maxStagedBytes
      )
        return { kind: 'limit' };
      if (existing) await parts.delete({ sessionId, partIndex, state: 'DELETED' });
      const part = parts.create({
        sessionId,
        partIndex,
        sizeBytes,
        stagingKey,
        digest: null,
        encryptionIv: null,
        state: 'RESERVED',
        objectDeletedAt: null,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
        createdAt: now,
        updatedAt: now,
      });
      await parts.insert(part);
      await this.changeUsage(manager, usage, 'stagedBytes', amount);
      return { kind: 'reserved', part };
    });
  }

  @classifyPersistenceOperation
  async commitPart(
    sessionId: string,
    partIndex: number,
    digest: string,
    encryptionIv: string | null,
    stagingKey?: string,
    inactivitySeconds?: number,
  ): Promise<{ expiresAt: Date } | null> {
    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(VfsUploadSessionEntity);
      const session = await sessions.findOneBy({ id: sessionId });
      if (!session) return null;
      await this.lockUsage(manager, session.namespaceId);
      const current = await sessions.findOneBy({ id: sessionId });
      const now = new Date();
      if (!current || current.state !== 'OPEN' || current.expiresAt <= now || current.maxExpiresAt <= now)
        return null;
      const part = await manager.getRepository(VfsUploadPartEntity).findOneBy({ sessionId, partIndex });
      if (
        !part ||
        part.state !== 'RESERVED' ||
        !part.leaseExpiresAt ||
        part.leaseExpiresAt <= now ||
        (stagingKey !== undefined && part.stagingKey !== stagingKey)
      )
        return null;
      // 만료 갱신을 하지 않는 호출은 현재 저장된 만료 시각을 돌려준다.
      let expiresAt = current.expiresAt;
      if (inactivitySeconds !== undefined) {
        expiresAt = new Date(
          Math.min(now.getTime() + inactivitySeconds * 1000, current.maxExpiresAt.getTime()),
        );
        const renewed = await sessions
          .createQueryBuilder()
          .update()
          .set({ expiresAt, updatedAt: now })
          .where('id = :sessionId AND state = :state AND expires_at > :now AND max_expires_at > :now', {
            sessionId,
            state: 'OPEN',
            now,
          })
          .execute();
        if (renewed.affected !== 1) return null;
      }
      const update = manager
        .getRepository(VfsUploadPartEntity)
        .createQueryBuilder()
        .update()
        .set({ state: 'STORED', digest, encryptionIv, updatedAt: now })
        .where('session_id = :sessionId AND part_index = :partIndex AND state = :state', {
          sessionId,
          partIndex,
          state: 'RESERVED',
        });
      if (stagingKey !== undefined) update.andWhere('staging_key = :stagingKey', { stagingKey });
      const result = await update.execute();
      if (result.affected !== 1) throw new Error('Upload part changed during commit transaction');
      return { expiresAt };
    });
  }

  @classifyPersistenceOperation
  async renewPartLease(
    sessionId: string,
    partIndex: number,
    stagingKey: string,
    leaseSeconds = 60,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(VfsUploadPartEntity);
      const query = repo
        .createQueryBuilder('part')
        .where(
          'part.session_id = :sessionId AND part.part_index = :partIndex AND part.staging_key = :stagingKey AND part.state = :state',
          { sessionId, partIndex, stagingKey, state: 'RESERVED' },
        );
      if (!isSqliteDataSource(this.dataSource.options)) query.setLock('pessimistic_write');
      const part = await query.getOne();
      const lockedNow = new Date();
      if (!part || !part.leaseExpiresAt || part.leaseExpiresAt <= lockedNow) return false;
      const result = await repo
        .createQueryBuilder()
        .update()
        .set({ leaseExpiresAt: new Date(lockedNow.getTime() + leaseSeconds * 1000), updatedAt: lockedNow })
        .where('session_id = :sessionId AND part_index = :partIndex AND staging_key = :stagingKey', {
          sessionId,
          partIndex,
          stagingKey,
        })
        .andWhere('state = :state AND lease_expires_at > :now', { state: 'RESERVED', now: lockedNow })
        .execute();
      return result.affected === 1;
    });
  }

  @classifyPersistenceOperation
  async retireExpiredPartReservation(
    sessionId: string,
    partIndex: number,
    stagingKey: string,
    _observedNow = new Date(),
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const session = await manager.getRepository(VfsUploadSessionEntity).findOneBy({ id: sessionId });
      if (!session) return false;
      await this.lockUsage(manager, session.namespaceId);
      const parts = manager.getRepository(VfsUploadPartEntity);
      const query = parts
        .createQueryBuilder('part')
        .where(
          'part.session_id = :sessionId AND part.part_index = :partIndex AND part.staging_key = :stagingKey',
          { sessionId, partIndex, stagingKey },
        );
      if (!isSqliteDataSource(this.dataSource.options)) query.setLock('pessimistic_write');
      const part = await query.getOne();
      const lockedNow = new Date();
      if (
        !part ||
        part.state !== 'RESERVED' ||
        part.stagingKey !== stagingKey ||
        (part.leaseExpiresAt !== null && part.leaseExpiresAt > lockedNow)
      )
        return false;
      const removed = await parts
        .createQueryBuilder()
        .delete()
        .where(
          'session_id = :sessionId AND part_index = :partIndex AND staging_key = :stagingKey AND state = :state',
          { sessionId, partIndex, stagingKey, state: 'RESERVED' },
        )
        .andWhere('(lease_expires_at IS NULL OR lease_expires_at <= :now)', { now: lockedNow })
        .execute();
      if (removed.affected !== 1) return false;
      await manager.getRepository(VfsUploadStagingCleanupEntity).insert({
        stagingKey,
        sessionId,
        partIndex,
        namespaceId: session.namespaceId,
        sizeBytes: part.sizeBytes,
        deletedAt: null,
        putSettledAt: null,
        createdAt: lockedNow,
      });
      // This old generation remains charged until its PUT settles and deletion is confirmed.
      return true;
    });
  }

  // objectMayExist=true이면 GC가 삭제를 재시도할 수 있도록 객체 참조와 과금을 보존한다.
  // GC가 in-flight put보다 먼저 DELETED 처리했다면 같은 key의 뒤늦은 객체를 다시 과금한다.
  @classifyPersistenceOperation
  async releasePartReservation(
    sessionId: string,
    partIndex: number,
    objectMayExist = false,
    stagingKey?: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const session = await manager.getRepository(VfsUploadSessionEntity).findOneBy({ id: sessionId });
      if (!session) return false;
      const usage = await this.lockUsage(manager, session.namespaceId);
      const repo = manager.getRepository(VfsUploadPartEntity);
      const part = await repo.findOneBy({ sessionId, partIndex });
      if (!part || (stagingKey !== undefined && part.stagingKey !== stagingKey)) {
        if (stagingKey === undefined) return false;
        const tombstones = manager.getRepository(VfsUploadStagingCleanupEntity);
        const old = await tombstones.findOneBy({ stagingKey, sessionId, partIndex });
        if (!old) return false;
        if (objectMayExist) {
          await tombstones.update({ stagingKey }, { putSettledAt: new Date() });
        } else {
          await tombstones.delete({ stagingKey });
          await this.changeUsage(manager, usage, 'stagedBytes', -BigInt(old.sizeBytes));
        }
        return true;
      }
      if (part.state === 'DELETED') {
        if (!objectMayExist || stagingKey === undefined || part.objectDeletedAt === null) return false;
        const restored = await repo.update(
          { sessionId, partIndex, stagingKey, state: 'DELETED' },
          { state: 'CLEANUP', objectDeletedAt: null, updatedAt: new Date() },
        );
        if (restored.affected !== 1) return false;
        await this.changeUsage(manager, usage, 'stagedBytes', BigInt(part.sizeBytes));
        return true;
      }
      if (part.state !== 'RESERVED') return false;
      if (objectMayExist)
        await repo.update({ sessionId, partIndex }, { state: 'CLEANUP', updatedAt: new Date() });
      else {
        await repo.delete({ sessionId, partIndex });
        await this.changeUsage(manager, usage, 'stagedBytes', -BigInt(part.sizeBytes));
      }
      return true;
    });
  }

  @classifyPersistenceOperation
  async claimTerminalTransition(
    namespaceId: string,
    sessionId: string,
    next: 'CANCELLED' | 'EXPIRED',
    now: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const usage = await this.lockUsage(manager, namespaceId);
      const repo = manager.getRepository(VfsUploadSessionEntity);
      const session = await repo.findOneBy({ id: sessionId, namespaceId });
      const expected: VfsUploadSessionState = 'OPEN';
      if (!session || session.state !== expected) return false;
      const result = await repo
        .createQueryBuilder()
        .update()
        .set({
          state: next,
          terminalAt: now,
          leaseExpiresAt: null,
          leaseToken: null,
          lastCompleteFailureCode: null,
          lastCompleteFailureAt: null,
          updatedAt: now,
        })
        .where('id = :sessionId AND namespace_id = :namespaceId AND state = :expected', {
          sessionId,
          namespaceId,
          expected,
        })
        .andWhere(next === 'EXPIRED' ? '(expires_at <= :now OR max_expires_at <= :now)' : '1 = 1', { now })
        .execute();
      if (result.affected !== 1) return false;
      await this.changeUsage(manager, usage, 'activeSessions', -1n);
      return true;
    });
  }

  @classifyPersistenceOperation
  async claimFinalize(
    namespaceId: string,
    sessionId: string,
    leaseDurationMs: number,
  ): Promise<
    | { kind: 'claimed'; token: string; session: VfsUploadSessionEntity; parts: VfsUploadPartEntity[] }
    | { kind: 'not-found' }
    | { kind: 'incomplete' }
    | { kind: 'busy' }
    | { kind: 'closed' }
    | { kind: 'complete'; session: VfsUploadSessionEntity }
  > {
    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(VfsUploadSessionEntity);
      // 없는 namespace에 usage 행을 만들면 FK 오류가 404를 500으로 바꾼다.
      if (!(await sessions.findOneBy({ id: sessionId, namespaceId }))) return { kind: 'not-found' };
      await this.lockUsage(manager, namespaceId);
      await this.assertNamespaceActive(manager, namespaceId);
      const session = await sessions.findOneBy({ id: sessionId, namespaceId });
      if (!session) return { kind: 'not-found' };
      const now = new Date();
      if (session.state === 'COMPLETED' || session.state === 'FAILED') return { kind: 'complete', session };
      if (session.state === 'FINALIZING') return { kind: 'busy' };
      if (session.state !== 'OPEN' || session.expiresAt <= now || session.maxExpiresAt <= now)
        return { kind: 'closed' };
      const parts = await manager.getRepository(VfsUploadPartEntity).find({
        where: { sessionId, state: 'STORED' },
        order: { partIndex: 'ASC' },
      });
      if (
        parts.length !== session.partCount ||
        parts.some((part, index) => part.partIndex !== index || !part.digest)
      )
        return { kind: 'incomplete' };
      const claimNow = new Date();
      if (session.expiresAt <= claimNow || session.maxExpiresAt <= claimNow) return { kind: 'closed' };
      const token = randomUUID();
      const leaseExpiresAt = new Date(claimNow.getTime() + leaseDurationMs);
      const claimed = await sessions
        .createQueryBuilder()
        .update()
        .set({
          state: 'FINALIZING',
          leaseToken: token,
          leaseExpiresAt,
          lastCompleteFailureCode: null,
          lastCompleteFailureAt: null,
          updatedAt: claimNow,
        })
        .where(
          'id = :sessionId AND namespace_id = :namespaceId AND state = :state AND expires_at > :now AND max_expires_at > :now',
          { sessionId, namespaceId, state: 'OPEN', now: claimNow },
        )
        .execute();
      if (claimed.affected !== 1) return { kind: 'busy' };
      return { kind: 'claimed', token, session, parts };
    });
  }

  @classifyPersistenceOperation
  async renewFinalize(
    namespaceId: string,
    sessionId: string,
    token: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(VfsUploadSessionEntity);
      const query = repo
        .createQueryBuilder('session')
        .where(
          'session.id = :sessionId AND session.namespace_id = :namespaceId AND session.state = :state AND session.lease_token = :token',
          { sessionId, namespaceId, state: 'FINALIZING', token },
        );
      if (!isSqliteDataSource(this.dataSource.options)) query.setLock('pessimistic_write');
      const session = await query.getOne();
      const lockedNow = new Date();
      if (!session || !session.leaseExpiresAt || session.leaseExpiresAt <= lockedNow) return false;
      const durationMs = leaseExpiresAt.getTime() - now.getTime();
      const result = await repo
        .createQueryBuilder()
        .update()
        .set({ leaseExpiresAt: new Date(lockedNow.getTime() + durationMs), updatedAt: lockedNow })
        .where(
          'id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token AND lease_expires_at > :now',
          { sessionId, namespaceId, state: 'FINALIZING', token, now: lockedNow },
        )
        .execute();
      return result.affected === 1;
    });
  }

  // Node mutation과 같은 transaction에서 usage 다음 session row를 잠그고 claim을 검증한다.
  // 회수된 옛 worker는 여기서 실패하며, 검증 성공 뒤 GC 회수는 commit까지 대기한다.
  @classifyPersistenceOperation
  async fenceFinalize(
    manager: EntityManager,
    namespaceId: string,
    sessionId: string,
    token: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<void> {
    await this.lockUsage(manager, namespaceId);
    const lockedNow = new Date();
    const leaseDurationMs = leaseExpiresAt.getTime() - now.getTime();
    const lockedLeaseExpiresAt = new Date(lockedNow.getTime() + leaseDurationMs);
    const fenced = await manager
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder()
      .update()
      .set({ leaseExpiresAt: lockedLeaseExpiresAt, updatedAt: lockedNow })
      .where(
        'id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token AND lease_expires_at > :now',
        { sessionId, namespaceId, state: 'FINALIZING', token, now: lockedNow },
      )
      .execute();
    if (fenced.affected !== 1) throw new Error('Upload finalize claim lost');
  }

  @classifyPersistenceOperation
  async completeFinalize(
    manager: EntityManager,
    namespaceId: string,
    sessionId: string,
    token: string,
    status: number,
    body: string,
    requestId: string,
  ): Promise<void> {
    const now = new Date();
    const completed = await manager
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder()
      .update()
      .set({
        state: 'COMPLETED',
        leaseToken: null,
        leaseExpiresAt: null,
        lastCompleteFailureCode: null,
        lastCompleteFailureAt: null,
        terminalAt: now,
        responseStatus: status,
        responseBody: body,
        requestId,
        updatedAt: now,
      })
      .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token', {
        sessionId,
        namespaceId,
        state: 'FINALIZING',
        token,
      })
      .execute();
    if (completed.affected !== 1) throw new Error('Upload finalize claim lost');
    const usage = await this.lockUsage(manager, namespaceId);
    await this.changeUsage(manager, usage, 'activeSessions', -1n);
  }

  @classifyPersistenceOperation
  async failFinalize(
    namespaceId: string,
    sessionId: string,
    token: string,
    body: string,
    requestId: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const usage = await this.lockUsage(manager, namespaceId);
      const now = new Date();
      const failed = await manager
        .getRepository(VfsUploadSessionEntity)
        .createQueryBuilder()
        .update()
        .set({
          state: 'FAILED',
          leaseToken: null,
          leaseExpiresAt: null,
          lastCompleteFailureCode: null,
          lastCompleteFailureAt: null,
          terminalAt: now,
          responseStatus: 422,
          responseBody: body,
          requestId,
          updatedAt: now,
        })
        .where(
          'id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token AND lease_expires_at > :now',
          { sessionId, namespaceId, state: 'FINALIZING', token, now },
        )
        .execute();
      if (failed.affected !== 1) return false;
      await this.changeUsage(manager, usage, 'activeSessions', -1n);
      return true;
    });
  }

  @classifyPersistenceOperation
  async releaseFinalize(
    namespaceId: string,
    sessionId: string,
    token: string,
    failure: { code: string; at: Date },
  ): Promise<boolean> {
    // OPEN 복귀와 실패 진단 저장은 한 UPDATE다. token이 다르면(회수된 늦은 작업자) 둘 다 적용하지 않는다.
    const result = await this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder()
      .update()
      .set({
        state: 'OPEN',
        leaseToken: null,
        leaseExpiresAt: null,
        lastCompleteFailureCode: failure.code,
        lastCompleteFailureAt: failure.at,
        updatedAt: new Date(),
      })
      .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token', {
        sessionId,
        namespaceId,
        state: 'FINALIZING',
        token,
      })
      .execute();
    return result.affected === 1;
  }

  @classifyPersistenceOperation
  async renewSession(
    namespaceId: string,
    sessionId: string,
    now: Date,
    inactivitySeconds: number,
  ): Promise<{ expiresAt: Date } | null> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockUsage(manager, namespaceId);
      await this.assertNamespaceActive(manager, namespaceId);
      const repo = manager.getRepository(VfsUploadSessionEntity);
      const query = repo
        .createQueryBuilder('session')
        .where('session.id = :sessionId AND session.namespace_id = :namespaceId', { sessionId, namespaceId });
      if (!isSqliteDataSource(this.dataSource.options)) query.setLock('pessimistic_write');
      const session = await query.getOne();
      const lockedNow = new Date();
      if (
        !session ||
        session.state !== 'OPEN' ||
        session.expiresAt <= lockedNow ||
        session.maxExpiresAt <= lockedNow
      )
        return null;
      const expiresAt = new Date(
        Math.min(lockedNow.getTime() + inactivitySeconds * 1000, session.maxExpiresAt.getTime()),
      );
      const result = await repo
        .createQueryBuilder()
        .update()
        .set({ expiresAt, updatedAt: lockedNow })
        .where(
          'id = :sessionId AND namespace_id = :namespaceId AND state = :state AND expires_at > :now AND max_expires_at > :now',
          {
            sessionId,
            namespaceId,
            state: 'OPEN',
            now: lockedNow,
          },
        )
        .execute();
      return result.affected === 1 ? { expiresAt } : null;
    });
  }

  @classifyPersistenceOperation
  async findForStatus(
    namespaceId: string,
    sessionId: string,
  ): Promise<{ session: VfsUploadSessionEntity; parts: VfsUploadPartEntity[] } | null> {
    const session = await this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .findOneBy({ id: sessionId, namespaceId });
    if (!session) return null;
    const parts = await this.dataSource
      .getRepository(VfsUploadPartEntity)
      .find({ where: { sessionId, state: 'STORED' }, order: { partIndex: 'ASC' } });
    return { session, parts: parts.map((part) => ({ ...part, sizeBytes: String(part.sizeBytes) })) };
  }

  @classifyPersistenceOperation
  async findPart(sessionId: string, partIndex: number): Promise<VfsUploadPartEntity | null> {
    return this.dataSource.getRepository(VfsUploadPartEntity).findOneBy({ sessionId, partIndex });
  }

  /**
   * commit ACK를 잃은 PUT의 복구 조회. 저장 확정(STORED)·staging key·digest를 확인하고 같은 SQL 문이 읽은
   * 세션 만료 시각을 함께 돌려준다. 확정되지 않았으면 null이다. 만료 시각은 이 조회 시점의 값이라
   * 다른 PUT이 그 사이에 갱신했다면 원래 요청의 갱신값보다 늦을 수 있다.
   */
  @classifyPersistenceOperation
  async findStoredPartWithExpiry(
    sessionId: string,
    partIndex: number,
    stagingKey: string,
  ): Promise<{ part: VfsUploadPartEntity; expiresAt: Date } | null> {
    const session = await this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder('session')
      .innerJoinAndMapOne(
        'session.storedPart',
        VfsUploadPartEntity,
        'part',
        'part.session_id = session.id AND part.part_index = :partIndex AND part.staging_key = :stagingKey AND part.state = :stored AND part.digest IS NOT NULL',
        { partIndex, stagingKey, stored: 'STORED' },
      )
      .where('session.id = :sessionId', { sessionId })
      .getOne();
    const part = (session as (VfsUploadSessionEntity & { storedPart?: VfsUploadPartEntity }) | null)
      ?.storedPart;
    return session && part ? { part, expiresAt: session.expiresAt } : null;
  }

  @classifyPersistenceOperation
  async findByCreationKey(
    namespaceId: string,
    scope: string,
    creationKey: string,
  ): Promise<VfsUploadSessionEntity | null> {
    return this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .findOneBy({ namespaceId, scope, creationKey });
  }

  @classifyPersistenceOperation
  async findExpiredOpenSessions(
    now: Date,
    batchSize = 500,
    after: { expiresAt: string; id: string } | null = null,
  ): Promise<Array<Pick<VfsUploadSessionEntity, 'id' | 'namespaceId' | 'expiresAt'>>> {
    const query = this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder('session')
      .select(['session.id', 'session.namespaceId', 'session.expiresAt'])
      .where('session.state = :state AND (session.expires_at <= :now OR session.max_expires_at <= :now)', {
        state: 'OPEN',
        now,
      })
      .orderBy('session.expires_at', 'ASC')
      .addOrderBy('session.id', 'ASC')
      .take(batchSize);
    if (after) {
      query.andWhere(
        '(session.expires_at > :afterAt OR (session.expires_at = :afterAt AND session.id > :afterId))',
        { afterAt: new Date(after.expiresAt), afterId: after.id },
      );
    }
    return query.getMany();
  }

  /** `FINALIZING` lease가 만료된 session을 OPEN으로 되돌린다. 한 번에 최대 `batchSize`개이며 복구한 수를 돌려준다. */
  @classifyPersistenceOperation
  async recoverStaleFinalizingLeases(now: Date, batchSize = 500): Promise<number> {
    const stale = await this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder('session')
      .select('session.id', 'id')
      .where('session.state = :state AND session.lease_expires_at <= :now', { state: 'FINALIZING', now })
      .orderBy('session.id', 'ASC')
      .take(batchSize)
      .getRawMany<{ id: string }>();
    if (stale.length === 0) return 0;
    const result = await this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder()
      .update()
      .set({ state: 'OPEN', leaseToken: null, leaseExpiresAt: null, updatedAt: now })
      .where('id IN (:...ids) AND state = :state AND lease_expires_at <= :now', {
        ids: stale.map((row) => row.id),
        state: 'FINALIZING',
        now,
      })
      .execute();
    return result.affected ?? 0;
  }

  @classifyPersistenceOperation
  async findCleanupParts(
    after: Pick<VfsUploadPartEntity, 'sessionId' | 'partIndex'> | null = null,
    batchSize = 500,
  ): Promise<Array<Pick<VfsUploadPartEntity, 'sessionId' | 'partIndex' | 'stagingKey' | 'state'>>> {
    const query = this.dataSource
      .getRepository(VfsUploadPartEntity)
      .createQueryBuilder('part')
      .innerJoin(VfsUploadSessionEntity, 'session', 'session.id = part.session_id')
      .select(['part.sessionId', 'part.partIndex', 'part.stagingKey', 'part.state'])
      .where(`(part.state = :cleanup OR (session.state IN (:...states) AND part.state = :stored))`, {
        cleanup: 'CLEANUP',
        states: ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'],
        stored: 'STORED',
      })
      .orderBy('part.sessionId', 'ASC')
      .addOrderBy('part.partIndex', 'ASC')
      .take(batchSize);
    if (after) {
      query.andWhere(
        '(part.session_id > :sessionId OR (part.session_id = :sessionId AND part.part_index > :partIndex))',
        after,
      );
    }
    return query.getMany();
  }

  @classifyPersistenceOperation
  async findExpiredReservedParts(
    now: Date,
    after: Pick<VfsUploadPartEntity, 'sessionId' | 'partIndex'> | null = null,
    batchSize = 500,
  ): Promise<Array<Pick<VfsUploadPartEntity, 'sessionId' | 'partIndex' | 'stagingKey'>>> {
    const query = this.dataSource
      .getRepository(VfsUploadPartEntity)
      .createQueryBuilder('part')
      .select(['part.sessionId', 'part.partIndex', 'part.stagingKey'])
      .where('part.state = :state AND (part.lease_expires_at IS NULL OR part.lease_expires_at <= :now)', {
        state: 'RESERVED',
        now,
      })
      .orderBy('part.sessionId', 'ASC')
      .addOrderBy('part.partIndex', 'ASC')
      .take(batchSize);
    if (after)
      query.andWhere(
        '(part.session_id > :sessionId OR (part.session_id = :sessionId AND part.part_index > :partIndex))',
        after,
      );
    return query.getMany();
  }

  @classifyPersistenceOperation
  async findCleanupTombstones(
    after: string | null = null,
    batchSize = 500,
  ): Promise<VfsUploadStagingCleanupEntity[]> {
    const query = this.dataSource
      .getRepository(VfsUploadStagingCleanupEntity)
      .createQueryBuilder('old')
      .orderBy('old.stagingKey', 'ASC')
      .take(batchSize);
    if (after) query.where('old.staging_key > :after', { after });
    return query.getMany();
  }

  @classifyPersistenceOperation
  async markTombstoneDeleted(stagingKey: string, observedPutSettledAt: Date | null): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const tombstones = manager.getRepository(VfsUploadStagingCleanupEntity);
      const old = await tombstones.findOneBy({ stagingKey });
      if (!old) return false;
      const usage = await this.lockUsage(manager, old.namespaceId);
      const current = await tombstones.findOneBy({ stagingKey });
      if (!current) return false;
      if (
        observedPutSettledAt !== null &&
        current.putSettledAt !== null &&
        current.putSettledAt.getTime() === observedPutSettledAt.getTime()
      ) {
        await tombstones.delete({ stagingKey });
        await this.changeUsage(manager, usage, 'stagedBytes', -BigInt(current.sizeBytes));
      } else {
        await tombstones.update({ stagingKey }, { deletedAt: new Date() });
      }
      return true;
    });
  }

  @classifyPersistenceOperation
  /**
   * `keys` 중 아직 DB가 소유한 staging key만 돌려준다. 삭제되지 않은 part와 cleanup tombstone이 소유한다.
   * 질의는 청크 단위로 나눈다.
   */
  async findKnownStagingKeys(keys: readonly string[]): Promise<Set<string>> {
    const known = new Set<string>();
    const sqlite = isSqliteDataSource(this.dataSource.options);
    for (let i = 0; i < keys.length; i += KEY_LOOKUP_CHUNK_SIZE) {
      const chunk = keys.slice(i, i + KEY_LOOKUP_CHUNK_SIZE);
      const rows: { staging_key: string }[] = sqlite
        ? await this.dataSource.query(
            `SELECT staging_key FROM vfs_upload_part WHERE state != 'DELETED' AND staging_key IN (${chunk.map(() => '?').join(',')})
             UNION SELECT staging_key FROM vfs_upload_staging_cleanup WHERE staging_key IN (${chunk.map(() => '?').join(',')})`,
            [...chunk, ...chunk],
          )
        : await this.dataSource.query(
            `SELECT staging_key FROM vfs_upload_part WHERE state != 'DELETED' AND staging_key = ANY($1::text[])
             UNION SELECT staging_key FROM vfs_upload_staging_cleanup WHERE staging_key = ANY($1::text[])`,
            [chunk],
          );
      for (const row of rows) known.add(row.staging_key);
    }
    return known;
  }

  @classifyPersistenceOperation
  async markStagingObjectDeleted(
    sessionId: string,
    partIndex: number,
    stagingKey: string,
    expectedState: VfsUploadPartState,
  ): Promise<boolean> {
    if (expectedState === 'DELETED' || expectedState === 'RESERVED') return false;
    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(VfsUploadSessionEntity);
      const session = await sessions.findOneBy({ id: sessionId });
      if (!session) return false;
      const usage = await this.lockUsage(manager, session.namespaceId);
      const currentSession = await sessions.findOneBy({ id: sessionId });
      if (!currentSession) return false;
      const repo = manager.getRepository(VfsUploadPartEntity);
      const part = await repo.findOneBy({ sessionId, partIndex });
      if (!part || part.state !== expectedState || part.stagingKey !== stagingKey) return false;
      if (currentSession.state === 'OPEN' && expectedState !== 'CLEANUP') return false;
      const deleted = await repo.update(
        { sessionId, partIndex, stagingKey, state: expectedState },
        { state: 'DELETED', objectDeletedAt: new Date(), updatedAt: new Date() },
      );
      if (deleted.affected !== 1) return false;
      await this.changeUsage(manager, usage, 'stagedBytes', -BigInt(part.sizeBytes));
      return true;
    });
  }

  @classifyPersistenceOperation
  async pruneTerminalSessions(before: Date, batchSize = 500): Promise<number> {
    const sessions = await this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder('session')
      .where('session.state IN (:...states) AND session.terminal_at < :before', {
        states: ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'],
        before,
      })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM "vfs_upload_part" part
        WHERE part.session_id = session.id AND part.state != :deleted)`,
        { deleted: 'DELETED' },
      )
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM "vfs_upload_staging_cleanup" old WHERE old.session_id = session.id)',
      )
      .orderBy('session.terminal_at', 'ASC')
      .addOrderBy('session.id', 'ASC')
      .take(batchSize)
      .getMany();
    let deleted = 0;
    for (const session of sessions) {
      await this.dataSource.transaction(async (manager) => {
        const remaining = await manager.getRepository(VfsUploadPartEntity).count({
          where: [
            { sessionId: session.id, state: 'RESERVED' },
            { sessionId: session.id, state: 'STORED' },
            { sessionId: session.id, state: 'CLEANUP' },
          ],
        });
        if (remaining !== 0) return;
        const result = await manager
          .getRepository(VfsUploadSessionEntity)
          .createQueryBuilder()
          .delete()
          .where('id = :id AND terminal_at < :before AND state IN (:...states)', {
            id: session.id,
            before,
            states: ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'],
          })
          .execute();
        if (result.affected === 1) deleted++;
      });
    }
    return deleted;
  }
  /** 삭제 대상 namespace의 OPEN session ID를 읽는다. */
  async findOpenSessionIds(namespaceId: string): Promise<string[]> {
    return (await this.dataSource.manager.findBy(VfsUploadSessionEntity, { namespaceId, state: 'OPEN' })).map(
      (session) => session.id,
    );
  }

  /** 정리 단계 진입을 막는 OPEN·FINALIZING session을 센다. */
  async countLiveSessions(namespaceId: string): Promise<number> {
    return this.dataSource.manager.count(VfsUploadSessionEntity, {
      where: [
        { namespaceId, state: 'OPEN' },
        { namespaceId, state: 'FINALIZING' },
      ],
    });
  }

  /** terminal session도 완료 전에 모두 제거되어야 한다. */
  async countSessions(namespaceId: string): Promise<number> {
    return this.dataSource.manager.countBy(VfsUploadSessionEntity, { namespaceId });
  }

  /** PUT 정착 여부를 namespace별로 읽는다. */
  async countTombstones(namespaceId: string): Promise<{ total: number; unsettled: number }> {
    return {
      total: await this.dataSource.manager.countBy(VfsUploadStagingCleanupEntity, { namespaceId }),
      unsettled: await this.dataSource.manager.countBy(VfsUploadStagingCleanupEntity, {
        namespaceId,
        putSettledAt: IsNull(),
      }),
    };
  }

  /** namespace usage만 읽으며 global usage는 다시 차감하지 않는다. */
  async readNamespaceUsage(
    namespaceId: string,
    manager = this.dataSource.manager,
  ): Promise<{ activeSessions: string; stagedBytes: string }> {
    const rows = (await manager.query(
      `SELECT CAST(active_sessions AS TEXT) AS "activeSessions", CAST(staged_bytes AS TEXT) AS "stagedBytes" FROM vfs_upload_usage WHERE namespace_id = ${isSqliteDataSource(this.dataSource.options) ? '?' : '$1'}`,
      [namespaceId],
    )) as { activeSessions: string; stagedBytes: string }[];
    return rows[0] ?? { activeSessions: '0', stagedBytes: '0' };
  }

  /** usage 잠금 안에서 part와 같은 session의 tombstone 부재를 재검사한다. */
  async deleteSettledSessions(namespaceId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockUsage(manager, namespaceId);
      const result = await manager
        .getRepository(VfsUploadSessionEntity)
        .createQueryBuilder()
        .delete()
        .where('namespace_id = :namespaceId AND state IN (:...states)', {
          namespaceId,
          states: ['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'],
        })
        .andWhere(
          'NOT EXISTS (SELECT 1 FROM vfs_upload_part part WHERE part.session_id = vfs_upload_session.id AND part.state != :deleted)',
          { deleted: 'DELETED' },
        )
        .andWhere(
          'NOT EXISTS (SELECT 1 FROM vfs_upload_staging_cleanup old WHERE old.session_id = vfs_upload_session.id)',
        )
        .execute();
      return result.affected ?? 0;
    });
  }
}
