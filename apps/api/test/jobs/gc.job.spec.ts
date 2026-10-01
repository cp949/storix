import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { GcJob } from '../../src/jobs/gc.job.js';
import type { BlobRepository, OrphanBlobRow } from '../../src/persistence/blob.repository.js';
import type { BlobObjectInfo, BlobStorage } from '../../src/storage/blob-storage.js';
import type { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import type { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import { resolveChangeFeedRetentionDays } from '../../src/persistence/vfs-change-feed-retention.repository.js';
import type {
  ChangeFeedPruneCursor,
  ChangeFeedPruneResult,
  VfsChangeFeedRetentionRepository,
} from '../../src/persistence/vfs-change-feed-retention.repository.js';
import type { GcCursorRepository } from '../../src/persistence/gc-cursor.repository.js';

type PruneNext = (
  days: number,
  batchSize: number,
  after: ChangeFeedPruneCursor | null,
) => Promise<ChangeFeedPruneResult>;

describe('GcJob', () => {
  it('삭제 cleanup을 주입하지 않은 GC는 삭제 집계를 0으로 반환한다', async () => {
    const storage = { async *list() {}, delete: async () => undefined } as unknown as BlobStorage;
    const blobs = {
      findAllStorageKeys: async () => new Set<string>(),
      findOrphanBlobs: async () => [],
      deleteBlobRows: async () => undefined,
    } as unknown as BlobRepository;
    const result = await new GcJob(storage, blobs, makeConfig(3600)).run();
    expect(result).toMatchObject({
      advancedNamespaceDeletions: 0,
      completedNamespaceDeletions: 0,
      failedNamespaceDeletions: 0,
    });
  });

  it('change feed retention은 기본 30일과 엄격한 양의 안전 정수만 허용한다', () => {
    expect(resolveChangeFeedRetentionDays(undefined)).toBe(30);
    expect(resolveChangeFeedRetentionDays('1')).toBe(1);
    for (const invalid of ['', '0', '-1', '1.5', '1e2', ' 2', '2 ', '9007199254740992']) {
      expect(() => resolveChangeFeedRetentionDays(invalid)).toThrow();
    }
  });

  describe('change feed 보존 정리', () => {
    const cursorA: ChangeFeedPruneCursor = {
      occurredAt: '2026-01-01 00:00:00+00',
      namespaceId: 'ns-a',
      sequence: '3',
    };
    const cursorB: ChangeFeedPruneCursor = {
      occurredAt: '2026-01-02 00:00:00+00',
      namespaceId: 'ns-b',
      sequence: '9',
    };

    function makeJob(options: {
      readonly pruneNext: jest.Mock<PruneNext>;
      readonly budget?: string;
      readonly cursors?: GcCursorRepository;
    }): GcJob {
      const storage = { async *list() {}, delete: async () => undefined } as unknown as BlobStorage;
      const blobs = {
        findAllStorageKeys: async () => new Set<string>(),
        findOrphanBlobs: async () => [],
        deleteBlobRows: async () => undefined,
      } as unknown as BlobRepository;
      const config = {
        get: (key: string) =>
          key === 'STORIX_VFS_CHANGE_RETENTION_DAYS'
            ? '7'
            : key === 'STORIX_GC_MAX_ROWS_PER_STAGE'
              ? options.budget
              : '3600',
      } as unknown as ConfigService;
      return new GcJob(
        storage,
        blobs,
        config,
        undefined,
        undefined,
        { pruneNext: options.pruneNext } as unknown as VfsChangeFeedRetentionRepository,
        undefined,
        undefined,
        undefined,
        options.cursors,
      );
    }

    function makeCursors(stored: string | null) {
      const read = jest.fn<(name: string) => Promise<string | null>>().mockResolvedValue(stored);
      const write = jest.fn<(name: string, position: string) => Promise<void>>().mockResolvedValue(undefined);
      const clear = jest.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
      return { repository: { read, write, clear } as unknown as GcCursorRepository, read, write, clear };
    }

    it('next가 null이 될 때까지 이어 호출하고 삭제 수를 집계한 뒤 저장된 cursor를 지운다', async () => {
      const pruneNext = jest
        .fn<PruneNext>()
        .mockResolvedValueOnce({ deleted: 500, examined: 500, next: cursorA })
        .mockResolvedValueOnce({ deleted: 2, examined: 2, next: cursorB })
        .mockResolvedValueOnce({ deleted: 0, examined: 0, next: null });
      const cursors = makeCursors(null);
      const result = await makeJob({ pruneNext, cursors: cursors.repository }).run();
      expect(result.prunedChangeEvents).toBe(502);
      expect(result.budgetExhaustedStages).toEqual([]);
      expect(pruneNext.mock.calls.map((call) => call[2])).toEqual([null, cursorA, cursorB]);
      expect(pruneNext).toHaveBeenCalledWith(7, 500, null);
      expect(cursors.clear).toHaveBeenCalledWith('change-feed-prune');
      expect(cursors.write).not.toHaveBeenCalled();
    });

    it('읽은 이벤트 수가 예산에 도달하면 멈추고 cursor를 저장하고 단계를 보고한다', async () => {
      const pruneNext = jest
        .fn<PruneNext>()
        .mockResolvedValueOnce({ deleted: 0, examined: 500, next: cursorA })
        .mockResolvedValueOnce({ deleted: 3, examined: 500, next: cursorB });
      const cursors = makeCursors(null);
      const result = await makeJob({ pruneNext, budget: '1000', cursors: cursors.repository }).run();
      expect(pruneNext).toHaveBeenCalledTimes(2);
      expect(result.prunedChangeEvents).toBe(3);
      expect(result.budgetExhaustedStages).toEqual(['change-feed-prune']);
      expect(cursors.write).toHaveBeenCalledWith('change-feed-prune', JSON.stringify(cursorB));
      expect(cursors.clear).not.toHaveBeenCalled();
    });

    it('저장된 cursor에서 이어 시작한다', async () => {
      const pruneNext = jest.fn<PruneNext>().mockResolvedValue({ deleted: 0, examined: 0, next: null });
      const cursors = makeCursors(JSON.stringify(cursorA));
      await makeJob({ pruneNext, cursors: cursors.repository }).run();
      expect(pruneNext.mock.calls[0][2]).toEqual(cursorA);
    });

    it('읽을 수 없는 저장 cursor는 처음부터 다시 시작한다', async () => {
      const pruneNext = jest.fn<PruneNext>().mockResolvedValue({ deleted: 0, examined: 0, next: null });
      await makeJob({ pruneNext, cursors: makeCursors('not-json').repository }).run();
      expect(pruneNext.mock.calls[0][2]).toBeNull();
    });

    it('cursor 저장소가 없어도 정리한다', async () => {
      const pruneNext = jest
        .fn<PruneNext>()
        .mockResolvedValueOnce({ deleted: 1, examined: 1, next: cursorA })
        .mockResolvedValueOnce({ deleted: 0, examined: 0, next: null });
      expect((await makeJob({ pruneNext }).run()).prunedChangeEvents).toBe(1);
    });

    it('아무것도 읽지 못하는 호출이 이어져도 예산을 소모해 무한 반복하지 않는다', async () => {
      const pruneNext = jest.fn<PruneNext>().mockResolvedValue({ deleted: 0, examined: 0, next: cursorA });
      const result = await makeJob({ pruneNext, budget: '5' }).run();
      expect(pruneNext).toHaveBeenCalledTimes(5);
      expect(result.budgetExhaustedStages).toEqual(['change-feed-prune']);
    });
  });

  function makeConfig(gracePeriodSeconds: number): ConfigService {
    return { get: () => String(gracePeriodSeconds) } as unknown as ConfigService;
  }

  async function* emptyList(): AsyncIterable<BlobObjectInfo> {}

  it('prunes expired completed mutation receipts during GC', async () => {
    const storage = {
      list: emptyList,
      delete: jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const blobRepository = {
      findAllStorageKeys: jest.fn<() => Promise<Set<string>>>().mockResolvedValue(new Set()),
      findOrphanBlobs: jest.fn<() => Promise<OrphanBlobRow[]>>().mockResolvedValue([]),
      deleteBlobRows: jest.fn<(ids: string[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    const pruneExpired = jest.fn<(now: Date) => Promise<number>>().mockResolvedValue(2);
    const job = new GcJob(
      storage as unknown as BlobStorage,
      blobRepository as unknown as BlobRepository,
      makeConfig(3600),
      { pruneExpired } as unknown as VfsMutationReceiptRepository,
    );
    const result = await job.run();
    expect(result.prunedMutationReceipts).toBe(2);
    expect(pruneExpired).toHaveBeenCalledWith(expect.any(Date));
  });

  it('스토리지 object 삭제가 실패한 blob은 metadata row를 삭제하지 않는다', async () => {
    const deleteMock = jest
      .fn<(key: string) => Promise<void>>()
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error('storage down')));
    const storage: Pick<BlobStorage, 'list' | 'delete'> = {
      list: emptyList,
      delete: deleteMock,
    };
    const findOrphanBlobs = jest.fn<(cutoff: Date) => Promise<OrphanBlobRow[]>>().mockResolvedValue([
      { id: 'blob-ok', storageKey: 'blobs/ab/ok' },
      { id: 'blob-fail', storageKey: 'blobs/ab/fail' },
    ]);
    const deleteBlobRows = jest.fn<(ids: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const blobRepository: Pick<BlobRepository, 'findAllStorageKeys' | 'findOrphanBlobs' | 'deleteBlobRows'> =
      {
        findAllStorageKeys: jest.fn<() => Promise<Set<string>>>().mockResolvedValue(new Set()),
        findOrphanBlobs,
        deleteBlobRows,
      };

    const job = new GcJob(
      storage as unknown as BlobStorage,
      blobRepository as unknown as BlobRepository,
      makeConfig(3600),
    );

    const result = await job.run();

    expect(result.deletedOrphanBlobs).toBe(1);
    expect(deleteBlobRows).toHaveBeenCalledWith(['blob-ok']);
  });

  it('metadata 없이 grace period가 지난 스토리지 object만 orphan으로 센다', async () => {
    const now = Date.now();
    const staleItem: BlobObjectInfo = { key: 'blobs/ab/stale', lastModified: new Date(now - 2 * 3600_000) };
    const freshItem: BlobObjectInfo = { key: 'blobs/ab/fresh', lastModified: new Date(now) };
    const knownItem: BlobObjectInfo = { key: 'blobs/ab/known', lastModified: new Date(now - 2 * 3600_000) };
    async function* list(): AsyncIterable<BlobObjectInfo> {
      yield staleItem;
      yield freshItem;
      yield knownItem;
    }
    const deleteMock = jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
    const storage: Pick<BlobStorage, 'list' | 'delete'> = { list, delete: deleteMock };
    const blobRepository: Pick<BlobRepository, 'findAllStorageKeys' | 'findOrphanBlobs' | 'deleteBlobRows'> =
      {
        findAllStorageKeys: jest
          .fn<() => Promise<Set<string>>>()
          .mockResolvedValue(new Set(['blobs/ab/known'])),
        findOrphanBlobs: jest.fn<(cutoff: Date) => Promise<OrphanBlobRow[]>>().mockResolvedValue([]),
        deleteBlobRows: jest.fn<(ids: string[]) => Promise<void>>().mockResolvedValue(undefined),
      };

    const job = new GcJob(
      storage as unknown as BlobStorage,
      blobRepository as unknown as BlobRepository,
      makeConfig(3600),
    );

    const result = await job.run();

    expect(result.deletedOrphanObjects).toBe(1);
    expect(deleteMock).toHaveBeenCalledWith('blobs/ab/stale');
    expect(deleteMock).not.toHaveBeenCalledWith('blobs/ab/fresh');
    expect(deleteMock).not.toHaveBeenCalledWith('blobs/ab/known');
  });

  it('expires idle sessions, recovers stale leases, retries cleanup and protects active staging keys', async () => {
    const old = new Date(Date.now() - 7200_000);
    async function* list(prefix: string): AsyncIterable<BlobObjectInfo> {
      if (prefix === 'upload-staging/') {
        yield { key: 'upload-staging/active', lastModified: old };
        yield { key: 'upload-staging/orphan', lastModified: old };
      }
    }
    const deleteObject = jest.fn<(key: string) => Promise<void>>().mockImplementation(async (key) => {
      if (key === 'upload-staging/cleanup') throw new Error('temporary failure');
    });
    const uploads = {
      recoverStaleFinalizingLeases: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      findExpiredOpenSessions: jest
        .fn<() => Promise<Array<{ namespaceId: string; id: string }>>>()
        .mockResolvedValue([{ namespaceId: 'ns', id: 'expired' }]),
      claimTerminalTransition: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findCleanupParts: jest
        .fn<
          () => Promise<Array<{ sessionId: string; partIndex: number; stagingKey: string; state: 'CLEANUP' }>>
        >()
        .mockResolvedValue([
          { sessionId: 'expired', partIndex: 0, stagingKey: 'upload-staging/cleanup', state: 'CLEANUP' },
        ]),
      findExpiredReservedParts: async () => [],
      findCleanupTombstones: async () => [],
      markStagingObjectDeleted: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findAllStagingKeys: jest
        .fn<() => Promise<Set<string>>>()
        .mockResolvedValue(new Set(['upload-staging/active', 'upload-staging/cleanup'])),
      pruneTerminalSessions: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    };
    const job = new GcJob(
      { list, delete: deleteObject } as unknown as BlobStorage,
      {
        findAllStorageKeys: async () => new Set<string>(),
        findOrphanBlobs: async () => [],
        deleteBlobRows: async () => undefined,
      } as unknown as BlobRepository,
      makeConfig(3600),
      undefined,
      uploads as unknown as VfsUploadSessionRepository,
    );
    const result = await job.run();
    expect(result.deletedOrphanObjects).toBe(1);
    expect(deleteObject).not.toHaveBeenCalledWith('upload-staging/active');
    expect(deleteObject).toHaveBeenCalledWith('upload-staging/orphan');
    expect(uploads.claimTerminalTransition).toHaveBeenCalledWith(
      'ns',
      'expired',
      'EXPIRED',
      expect.any(Date),
    );
    expect(uploads.markStagingObjectDeleted).not.toHaveBeenCalled();
    expect(uploads.pruneTerminalSessions).toHaveBeenCalledWith(expect.any(Date));
  });

  it('continues past 500 failed cleanup candidates to a later part', async () => {
    const all = Array.from({ length: 501 }, (_, partIndex) => ({
      sessionId: 'session',
      partIndex,
      stagingKey: `upload-staging/${partIndex}`,
      state: 'CLEANUP' as const,
    }));
    const attempted: number[] = [];
    const marked: number[] = [];
    const uploads = {
      recoverStaleFinalizingLeases: async () => 0,
      findExpiredOpenSessions: async () => [],
      findCleanupParts: async (cursor?: { sessionId: string; partIndex: number } | null, batchSize = 500) =>
        all
          .filter((part) => cursor === undefined || cursor === null || part.partIndex > cursor.partIndex)
          .slice(0, batchSize),
      findExpiredReservedParts: async () => [],
      findCleanupTombstones: async () => [],
      markStagingObjectDeleted: async (_sessionId: string, partIndex: number) => {
        marked.push(partIndex);
        return true;
      },
      findAllStagingKeys: async () => new Set(all.map((part) => part.stagingKey)),
      pruneTerminalSessions: async () => 0,
    };
    const storage = {
      async *list() {},
      delete: async (key: string) => {
        const index = Number(key.split('/')[1]);
        attempted.push(index);
        if (index < 500) throw new Error('unavailable');
      },
    };
    const blobs = {
      findAllStorageKeys: async () => new Set<string>(),
      findOrphanBlobs: async () => [],
      deleteBlobRows: async () => undefined,
    };
    const job = new GcJob(
      storage as unknown as BlobStorage,
      blobs as unknown as BlobRepository,
      makeConfig(3600),
      undefined,
      uploads as unknown as VfsUploadSessionRepository,
    );
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await job.run();
    } finally {
      log.mockRestore();
    }
    expect(attempted).toHaveLength(501);
    expect(marked).toEqual([500]);
  });
});
