import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { VfsUploadPartEntity, type VfsUploadPartState } from './entities/vfs-upload-part.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { VfsUploadSessionEntity, type VfsUploadSessionState } from './entities/vfs-upload-session.entity.js';
import { VfsUploadUsageEntity } from './entities/vfs-upload-usage.entity.js';

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
  readonly mimeType: string;
  readonly conditionType: 'ABSENT' | 'REVISION';
  readonly conditionRevision: string | null;
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
  | { readonly kind: 'limit' | 'closed' | 'invalid' };

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
    const namespaceKey = `ns:${namespaceId.toLowerCase()}`;
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

  async createSession(
    input: CreateUploadSessionInput,
    caps: UploadSessionCaps,
  ): Promise<CreateUploadSessionResult> {
    return this.dataSource.transaction(async (manager) => {
      const usage = await this.lockUsage(manager, input.namespaceId);
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
        requestId: input.requestId ?? null,
        createdAt: input.now,
        updatedAt: input.now,
        creationExpiresAt: input.expiresAt,
      });
      await repo.insert(session);
      await this.changeUsage(manager, usage, 'activeSessions', 1n);
      return { kind: 'created', session };
    });
  }

  async reservePart(
    sessionId: string,
    partIndex: number,
    sizeBytes: string,
    stagingKey: string,
    caps: UploadSessionCaps,
  ): Promise<ReserveUploadPartResult> {
    const amount = BigInt(sizeBytes);
    if (amount <= 0n || !Number.isSafeInteger(partIndex) || partIndex < 0) return { kind: 'invalid' };
    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(VfsUploadSessionEntity);
      const session = await sessions.findOneBy({ id: sessionId });
      if (!session || session.state !== 'OPEN') return { kind: 'closed' };
      const usage = await this.lockUsage(manager, session.namespaceId);
      // Lock 대기 중 cancel/expire가 커밋됐을 수 있으므로 상태를 다시 읽는다.
      const current = await sessions.findOneBy({ id: sessionId });
      const now = new Date();
      if (!current || current.state !== 'OPEN' || current.expiresAt <= now || current.maxExpiresAt <= now)
        return { kind: 'closed' };
      const parts = manager.getRepository(VfsUploadPartEntity);
      const existing = await parts.findOneBy({ sessionId, partIndex });
      if (existing && (existing.state !== 'DELETED' || existing.objectDeletedAt === null))
        return { kind: 'exists', part: existing };
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
        createdAt: now,
        updatedAt: now,
      });
      await parts.insert(part);
      await this.changeUsage(manager, usage, 'stagedBytes', amount);
      return { kind: 'reserved', part };
    });
  }

  async commitPart(
    sessionId: string,
    partIndex: number,
    digest: string,
    encryptionIv: string | null,
    stagingKey?: string,
    inactivitySeconds?: number,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(VfsUploadSessionEntity);
      const session = await sessions.findOneBy({ id: sessionId });
      if (!session) return false;
      await this.lockUsage(manager, session.namespaceId);
      const current = await sessions.findOneBy({ id: sessionId });
      const now = new Date();
      if (!current || current.state !== 'OPEN' || current.expiresAt <= now || current.maxExpiresAt <= now)
        return false;
      const part = await manager.getRepository(VfsUploadPartEntity).findOneBy({ sessionId, partIndex });
      if (!part || part.state !== 'RESERVED' || (stagingKey !== undefined && part.stagingKey !== stagingKey))
        return false;
      if (inactivitySeconds !== undefined) {
        const expiresAt = new Date(Math.min(now.getTime() + inactivitySeconds * 1000,
          current.maxExpiresAt.getTime()));
        const renewed = await sessions.createQueryBuilder().update()
          .set({ expiresAt, updatedAt: now })
          .where('id = :sessionId AND state = :state AND expires_at > :now AND max_expires_at > :now',
            { sessionId, state: 'OPEN', now })
          .execute();
        if (renewed.affected !== 1) return false;
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
      return true;
    });
  }

  // objectMayExist=true이면 GC가 삭제를 재시도할 수 있도록 객체 참조와 과금을 보존한다.
  // GC가 in-flight put보다 먼저 DELETED 처리했다면 같은 key의 뒤늦은 객체를 다시 과금한다.
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
      if (!part || (stagingKey !== undefined && part.stagingKey !== stagingKey)) return false;
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

  async claimFinalize(namespaceId: string, sessionId: string, leaseDurationMs: number): Promise<
    | { kind: 'claimed'; token: string; session: VfsUploadSessionEntity; parts: VfsUploadPartEntity[] }
    | { kind: 'not-found' } | { kind: 'incomplete' } | { kind: 'busy' } | { kind: 'closed' }
    | { kind: 'complete'; session: VfsUploadSessionEntity }
  > {
    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(VfsUploadSessionEntity);
      // 없는 namespace에 usage 행을 만들면 FK 오류가 404를 500으로 바꾼다.
      if (!(await sessions.findOneBy({ id: sessionId, namespaceId }))) return { kind: 'not-found' };
      await this.lockUsage(manager, namespaceId);
      const session = await sessions.findOneBy({ id: sessionId, namespaceId });
      if (!session) return { kind: 'not-found' };
      const now = new Date();
      if (session.state === 'COMPLETED') return { kind: 'complete', session };
      if (session.state === 'FINALIZING') return { kind: 'busy' };
      if (session.state !== 'OPEN' || session.expiresAt <= now || session.maxExpiresAt <= now)
        return { kind: 'closed' };
      const parts = await manager.getRepository(VfsUploadPartEntity).find({
        where: { sessionId, state: 'STORED' }, order: { partIndex: 'ASC' },
      });
      if (parts.length !== session.partCount || parts.some((part, index) =>
        part.partIndex !== index || !part.digest)) return { kind: 'incomplete' };
      const claimNow = new Date();
      if (session.expiresAt <= claimNow || session.maxExpiresAt <= claimNow) return { kind: 'closed' };
      const token = randomUUID();
      const leaseExpiresAt = new Date(claimNow.getTime() + leaseDurationMs);
      const claimed = await sessions.createQueryBuilder().update()
        .set({ state: 'FINALIZING', leaseToken: token, leaseExpiresAt, updatedAt: claimNow })
        .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND expires_at > :now AND max_expires_at > :now',
          { sessionId, namespaceId, state: 'OPEN', now: claimNow }).execute();
      if (claimed.affected !== 1) return { kind: 'busy' };
      return { kind: 'claimed', token, session, parts };
    });
  }

  async renewFinalize(namespaceId: string, sessionId: string, token: string,
    now: Date, leaseExpiresAt: Date): Promise<boolean> {
    const result = await this.dataSource.getRepository(VfsUploadSessionEntity).createQueryBuilder().update()
      .set({ leaseExpiresAt, updatedAt: now })
      .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token AND lease_expires_at > :now',
        { sessionId, namespaceId, state: 'FINALIZING', token, now }).execute();
    return result.affected === 1;
  }

  // Node mutation과 같은 transaction에서 usage 다음 session row를 잠그고 claim을 검증한다.
  // 회수된 옛 worker는 여기서 실패하며, 검증 성공 뒤 GC 회수는 commit까지 대기한다.
  async fenceFinalize(manager: EntityManager, namespaceId: string, sessionId: string,
    token: string, now: Date, leaseExpiresAt: Date): Promise<void> {
    await this.lockUsage(manager, namespaceId);
    const fenced = await manager.getRepository(VfsUploadSessionEntity).createQueryBuilder().update()
      .set({ leaseExpiresAt, updatedAt: now })
      .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token AND lease_expires_at > :now',
        { sessionId, namespaceId, state: 'FINALIZING', token, now }).execute();
    if (fenced.affected !== 1) throw new Error('Upload finalize claim lost');
  }

  async completeFinalize(manager: EntityManager, namespaceId: string, sessionId: string,
    token: string, status: number, body: string, requestId: string): Promise<void> {
    const now = new Date();
    const completed = await manager.getRepository(VfsUploadSessionEntity).createQueryBuilder().update()
      .set({ state: 'COMPLETED', leaseToken: null, leaseExpiresAt: null, terminalAt: now,
        responseStatus: status, responseBody: body, requestId, updatedAt: now })
      .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token',
        { sessionId, namespaceId, state: 'FINALIZING', token }).execute();
    if (completed.affected !== 1) throw new Error('Upload finalize claim lost');
    const usage = await this.lockUsage(manager, namespaceId);
    await this.changeUsage(manager, usage, 'activeSessions', -1n);
  }

  async releaseFinalize(namespaceId: string, sessionId: string, token: string): Promise<boolean> {
    const result = await this.dataSource.getRepository(VfsUploadSessionEntity).createQueryBuilder().update()
      .set({ state: 'OPEN', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND lease_token = :token',
        { sessionId, namespaceId, state: 'FINALIZING', token }).execute();
    return result.affected === 1;
  }

  async isFinalObjectReferenced(storageKey: string): Promise<boolean> {
    return this.dataSource.getRepository(BlobEntity).exists({ where: { storageKey } });
  }

  async renewSession(
    namespaceId: string,
    sessionId: string,
    now: Date,
    inactivitySeconds: number,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(VfsUploadSessionEntity);
      const session = await repo.findOneBy({ id: sessionId, namespaceId });
      if (!session || session.state !== 'OPEN' || session.expiresAt <= now || session.maxExpiresAt <= now)
        return false;
      const expiresAt = new Date(
        Math.min(now.getTime() + inactivitySeconds * 1000, session.maxExpiresAt.getTime()),
      );
      const result = await repo
        .createQueryBuilder()
        .update()
        .set({ expiresAt, updatedAt: now })
        .where('id = :sessionId AND namespace_id = :namespaceId AND state = :state AND expires_at > :now AND max_expires_at > :now', {
          sessionId,
          namespaceId,
          state: 'OPEN',
          now,
        })
        .execute();
      return result.affected === 1;
    });
  }

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

  async findPart(sessionId: string, partIndex: number): Promise<VfsUploadPartEntity | null> {
    return this.dataSource.getRepository(VfsUploadPartEntity).findOneBy({ sessionId, partIndex });
  }

  async findByCreationKey(namespaceId: string, scope: string, creationKey: string): Promise<VfsUploadSessionEntity | null> {
    return this.dataSource.getRepository(VfsUploadSessionEntity).findOneBy({ namespaceId, scope, creationKey });
  }

  async findExpiredOpenSessions(now: Date, batchSize = 500): Promise<Array<Pick<VfsUploadSessionEntity, 'id' | 'namespaceId'>>> {
    return this.dataSource.getRepository(VfsUploadSessionEntity)
      .createQueryBuilder('session')
      .select(['session.id', 'session.namespaceId', 'session.expiresAt'])
      .where('session.state = :state AND (session.expires_at <= :now OR session.max_expires_at <= :now)',
        { state: 'OPEN', now })
      .orderBy('session.expires_at', 'ASC')
      .take(batchSize)
      .getMany();
  }

  async recoverStaleFinalizingLeases(now: Date): Promise<number> {
    const result = await this.dataSource.getRepository(VfsUploadSessionEntity)
      .createQueryBuilder().update()
      .set({ state: 'OPEN', leaseToken: null, leaseExpiresAt: null, updatedAt: now })
      .where('state = :state AND lease_expires_at <= :now', { state: 'FINALIZING', now })
      .execute();
    return result.affected ?? 0;
  }

  async findCleanupParts(
    after: Pick<VfsUploadPartEntity, 'sessionId' | 'partIndex'> | null = null,
    batchSize = 500,
  ): Promise<Array<Pick<VfsUploadPartEntity, 'sessionId' | 'partIndex' | 'stagingKey' | 'state'>>> {
    const query = this.dataSource.getRepository(VfsUploadPartEntity)
      .createQueryBuilder('part')
      .innerJoin(VfsUploadSessionEntity, 'session', 'session.id = part.session_id')
      .select(['part.sessionId', 'part.partIndex', 'part.stagingKey', 'part.state'])
      .where('(part.state = :cleanup OR (session.state IN (:...states) AND part.state != :deleted))', {
        cleanup: 'CLEANUP', states: ['COMPLETED', 'CANCELLED', 'EXPIRED'], deleted: 'DELETED',
      })
      .orderBy('part.sessionId', 'ASC')
      .addOrderBy('part.partIndex', 'ASC')
      .take(batchSize);
    if (after) {
      query.andWhere('(part.session_id > :sessionId OR (part.session_id = :sessionId AND part.part_index > :partIndex))',
        after);
    }
    return query.getMany();
  }

  async findAllStagingKeys(): Promise<Set<string>> {
    const parts = await this.dataSource.getRepository(VfsUploadPartEntity)
      .createQueryBuilder('part')
      .select('part.stagingKey', 'stagingKey')
      .where('part.state != :deleted', { deleted: 'DELETED' })
      .getRawMany<{ stagingKey: string }>();
    return new Set(parts.map((part) => part.stagingKey));
  }

  async markStagingObjectDeleted(
    sessionId: string,
    partIndex: number,
    stagingKey: string,
    expectedState: VfsUploadPartState,
  ): Promise<boolean> {
    if (expectedState === 'DELETED') return false;
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

  async pruneTerminalSessions(before: Date, batchSize = 500): Promise<number> {
    const sessions = await this.dataSource
      .getRepository(VfsUploadSessionEntity)
      .createQueryBuilder('session')
      .where('session.state IN (:...states) AND session.terminal_at < :before', {
        states: ['COMPLETED', 'CANCELLED', 'EXPIRED'],
        before,
      })
      .andWhere(`NOT EXISTS (SELECT 1 FROM "vfs_upload_part" part
        WHERE part.session_id = session.id AND part.state != :deleted)`, { deleted: 'DELETED' })
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
            states: ['COMPLETED', 'CANCELLED', 'EXPIRED'],
          })
          .execute();
        if (result.affected === 1) deleted++;
      });
    }
    return deleted;
  }
}
