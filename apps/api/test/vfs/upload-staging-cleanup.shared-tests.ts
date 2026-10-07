/**
 * 실제 DB와 제어 저장소로 key 세대·DELETE 전 정착 관측·중복 정산을 검증한다.
 * 규칙은 docs/design/07-resumable-upload.md "staging 정리 module".
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
import type { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsUploadPartEntity } from '../../src/persistence/entities/vfs-upload-part.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { UploadStagingCleanup } from '../../src/vfs/upload-staging-cleanup.js';

/** DELETE 시작과 완료 경계를 테스트가 직접 제어한다. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** DELETE 경계를 직접 열어 sleep 없이 PUT 정착과 정산의 순서를 고정한다. */
class ControlledStorage {
  readonly objects = new Map<string, Buffer>();
  error: unknown = null;
  onDelete: (() => Promise<void>) | null = null;
  async put(key: string, source: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
    this.objects.set(key, Buffer.concat(chunks));
  }
  async delete(key: string) {
    await this.onDelete?.();
    if (this.error) throw this.error;
    this.objects.delete(key);
  }
}

/** 양쪽 DB에 같은 객체·row·사용량 시나리오를 등록한다. */
export function stagingCleanupTests(createDb: () => Promise<DataSource>) {
  let db: DataSource;
  let repository: VfsUploadSessionRepository;
  let storage: ControlledStorage;
  let cleanup: UploadStagingCleanup;
  let namespaceId: string;
  const caps = {
    global: { maxStagedBytes: 100n, maxActiveSessions: 10 },
    namespace: { maxStagedBytes: 100n, maxActiveSessions: 10 },
  };

  beforeEach(async () => {
    db = await createDb();
    repository = new VfsUploadSessionRepository(db);
    storage = new ControlledStorage();
    cleanup = new UploadStagingCleanup(storage as unknown as BlobStorage, repository);
    namespaceId = randomUUID();
    await db.getRepository(NamespaceEntity).insert({ id: namespaceId, name: 'cleanup' });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db?.destroy();
  });

  /** 기존 생성·예약 경로로 4바이트를 과금하고 정확한 key에 객체를 저장한다. */
  async function reserve() {
    const now = new Date();
    const created = await repository.createSession(
      {
        id: randomUUID(),
        namespaceId,
        scope: 'test',
        creationKey: randomUUID(),
        fingerprint: 'a'.repeat(64),
        targetPath: '/file',
        sizeBytes: '4',
        mimeType: 'text/plain',
        conditionType: 'ABSENT',
        conditionRevision: null,
        fileExpiresInSeconds: null,
        partSizeBytes: 4,
        partCount: 1,
        now,
        expiresAt: new Date(now.getTime() + 60_000),
        maxExpiresAt: new Date(now.getTime() + 120_000),
      },
      caps,
    );
    if (created.kind !== 'created') throw new Error('session creation failed');
    const target = {
      sessionId: created.session.id,
      partIndex: 0,
      stagingKey: `upload-staging/${randomUUID()}`,
    };
    expect((await repository.reservePart(target.sessionId, 0, '4', target.stagingKey, caps)).kind).toBe(
      'reserved',
    );
    await storage.put(target.stagingKey, Readable.from(['abcd']));
    return target;
  }
  /** lease만 만료시킨다. PUT 정착 증거는 별도로 기록한다. */
  async function retire(target: Awaited<ReturnType<typeof reserve>>) {
    await db
      .getRepository(VfsUploadPartEntity)
      .update({ sessionId: target.sessionId, partIndex: 0 }, { leaseExpiresAt: new Date(0) });
    expect(await repository.retireExpiredPartReservation(target.sessionId, 0, target.stagingKey)).toBe(true);
  }
  /** global과 namespace 카운터를 정확한 문자열로 대조한다. */
  async function staged(bytes: string) {
    expect((await repository.readNamespaceUsage(namespaceId)).stagedBytes).toBe(bytes);
    expect(
      await db.query("SELECT CAST(staged_bytes AS TEXT) AS value FROM vfs_upload_usage WHERE id = 'global'"),
    ).toEqual([{ value: bytes }]);
  }

  it('PUT 정착 후 삭제 성공은 정확한 key의 4바이트를 반환한다', async () => {
    const target = await reserve();
    expect(await cleanup.cleanupSettledReservation(target)).toEqual({
      kind: 'deleted',
      accountingRecorded: true,
      refundedBytes: '4',
    });
    expect(storage.objects.has(target.stagingKey)).toBe(false);
    expect(await repository.findPart(target.sessionId, 0)).toBeNull();
    await staged('0');
  });

  it('삭제 실패 뒤에도 PUT 정착 기록과 과금을 보존한다', async () => {
    const old = await reserve();
    await retire(old);
    const error = new Error('delete unavailable');
    storage.error = error;
    expect(await cleanup.cleanupSettledReservation(old)).toEqual({ kind: 'delete-failed', error });
    expect((await repository.findCleanupTombstone(old.stagingKey))?.putSettledAt).toBeInstanceOf(Date);
    expect(storage.objects.has(old.stagingKey)).toBe(true);
    await staged('4');
    const current = await reserve();
    expect(await cleanup.cleanupSettledReservation(current)).toEqual({ kind: 'delete-failed', error });
    expect((await repository.findPart(current.sessionId, 0))?.state).toBe('CLEANUP');
    expect(storage.objects.has(current.stagingKey)).toBe(true);
    await staged('8');
  });

  it('DELETE 도중 PUT가 정착하면 첫 정리는 과금을 유지하고 다음 정리만 반환한다', async () => {
    const target = await reserve();
    await retire(target);
    const started = deferred();
    const finish = deferred();
    storage.onDelete = async () => {
      started.resolve();
      await finish.promise;
    };
    const first = cleanup.cleanupTombstone(target.stagingKey);
    await started.promise;
    await repository.releasePartReservation(target.sessionId, 0, true, target.stagingKey);
    finish.resolve();
    expect(await first).toEqual({ kind: 'deleted', accountingRecorded: true, refundedBytes: '0' });
    await staged('4');
    expect(await repository.findCleanupTombstone(target.stagingKey)).not.toBeNull();
    storage.onDelete = null;
    expect(await cleanup.cleanupTombstone(target.stagingKey)).toEqual({
      kind: 'deleted',
      accountingRecorded: true,
      refundedBytes: '4',
    });
    expect(await repository.findCleanupTombstone(target.stagingKey)).toBeNull();
    expect(storage.objects.has(target.stagingKey)).toBe(false);
    await staged('0');
  });

  it('같은 index의 이전 key 정리는 새 key와 4바이트 과금을 보존한다', async () => {
    const old = await reserve();
    await retire(old);
    expect(await cleanup.cleanupTombstone(old.stagingKey)).toMatchObject({ refundedBytes: '0' });
    const key = `upload-staging/${randomUUID()}`;
    expect((await repository.reservePart(old.sessionId, 0, '4', key, caps)).kind).toBe('reserved');
    await storage.put(key, Readable.from(['new!']));
    const row = await repository.findPart(old.sessionId, 0);
    expect(await cleanup.cleanupSettledReservation(old)).toMatchObject({ refundedBytes: '4' });
    expect(await repository.findPart(old.sessionId, 0)).toEqual(row);
    expect(storage.objects.get(key)?.toString()).toBe('new!');
    expect(storage.objects.has(old.stagingKey)).toBe(false);
    await staged('4');
  });

  it('동시에 두 tombstone 정리가 끝나도 합계 반환은 4바이트다', async () => {
    const target = await reserve();
    await retire(target);
    await repository.releasePartReservation(target.sessionId, 0, true, target.stagingKey);
    const bothStarted = deferred();
    const finish = deferred();
    let starts = 0;
    storage.onDelete = async () => {
      if (++starts === 2) bothStarted.resolve();
      await finish.promise;
    };
    const first = cleanup.cleanupTombstone(target.stagingKey);
    const second = cleanup.cleanupTombstone(target.stagingKey);
    await bothStarted.promise;
    finish.resolve();
    const results = await Promise.all([first, second]);
    const bytes = results.map((result) => {
      expect(result.kind).toBe('deleted');
      return result.kind === 'deleted' ? BigInt(result.refundedBytes) : -100n;
    });
    expect(bytes[0] + bytes[1]).toBe(4n);
    expect(await repository.findCleanupTombstone(target.stagingKey)).toBeNull();
    expect(storage.objects.has(target.stagingKey)).toBe(false);
    await staged('0');
  });

  it('OPEN의 STORED 조각은 삭제하거나 정산하지 않는다', async () => {
    const target = await reserve();
    await repository.commitPart(target.sessionId, 0, 'a'.repeat(64), null, target.stagingKey);
    expect(await cleanup.cleanupStoredPart(target)).toEqual({ kind: 'skipped', reason: 'target-not-found' });
    expect(storage.objects.has(target.stagingKey)).toBe(true);
    expect((await repository.findPart(target.sessionId, 0))?.state).toBe('STORED');
    await staged('4');
  });

  it.each(['FAILED', 'CANCELLED', 'COMPLETED', 'EXPIRED'] as const)(
    '종결 세션 %s의 저장 조각 정리는 한 번만 반환한다',
    async (state) => {
      const target = await reserve();
      await repository.commitPart(target.sessionId, 0, 'a'.repeat(64), null, target.stagingKey);
      await db.getRepository(VfsUploadSessionEntity).update({ id: target.sessionId }, { state });
      expect(await cleanup.cleanupStoredPart(target)).toEqual({
        kind: 'deleted',
        accountingRecorded: true,
        refundedBytes: '4',
      });
      expect(await cleanup.cleanupStoredPart(target)).toEqual({
        kind: 'skipped',
        reason: 'target-not-found',
      });
      expect(storage.objects.has(target.stagingKey)).toBe(false);
      expect((await repository.findPart(target.sessionId, 0))?.state).toBe('DELETED');
      await staged('0');
    },
  );

  it('DELETE 성공 뒤 DB 오류는 전달되고 후속 정리로 카운터를 한 번만 반환한다', async () => {
    const target = await reserve();
    await retire(target);
    await repository.releasePartReservation(target.sessionId, 0, true, target.stagingKey);
    const error = new Error('database unavailable');
    const mark = jest.spyOn(repository, 'markTombstoneDeletedDetailed').mockRejectedValueOnce(error);
    await expect(cleanup.cleanupTombstone(target.stagingKey)).rejects.toBe(error);
    mark.mockRestore();
    expect(storage.objects.has(target.stagingKey)).toBe(false);
    expect(await repository.findCleanupTombstone(target.stagingKey)).not.toBeNull();
    await staged('4');
    expect(await cleanup.cleanupTombstone(target.stagingKey)).toMatchObject({ refundedBytes: '4' });
    expect(await cleanup.cleanupTombstone(target.stagingKey)).toEqual({
      kind: 'skipped',
      reason: 'target-not-found',
    });
    await staged('0');
  });
}
