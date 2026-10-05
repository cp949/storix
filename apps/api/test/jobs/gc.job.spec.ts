import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { GcJob } from '../../src/jobs/gc.job.js';
import type { OrphanBlobPageRow } from '../../src/persistence/blob.repository.js';
import { BlobRepositoryDouble, PagedStorage } from './gc-doubles.js';
import type { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import type { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import { resolveChangeFeedRetentionDays } from '../../src/persistence/vfs-change-feed-retention.repository.js';
import type {
  ChangeFeedPruneCursor,
  ChangeFeedPruneResult,
  VfsChangeFeedRetentionRepository,
} from '../../src/persistence/vfs-change-feed-retention.repository.js';
import type { GcCursorRepository } from '../../src/persistence/gc-cursor.repository.js';
import type { VfsTrashRetentionRepository } from '../../src/persistence/vfs-trash-retention.repository.js';
import type { VfsFileExpiryRepository } from '../../src/persistence/vfs-file-expiry.repository.js';
import type { IdempotencyReceiptRetentionRepository } from '../../src/persistence/idempotency-receipt-retention.repository.js';
import type { NamespaceDeletionCleanup } from '../../src/jobs/namespace-deletion.cleanup.js';
import {
  type NamespacePurgeRepository,
  resolveNamespaceDeletedRetentionDays,
} from '../../src/persistence/namespace-purge.repository.js';

type PruneNext = (
  days: number,
  batchSize: number,
  after: ChangeFeedPruneCursor | null,
) => Promise<ChangeFeedPruneResult>;

describe('GcJob', () => {
  it('삭제 cleanup을 주입하지 않은 GC는 삭제 집계를 0으로 반환한다', async () => {
    const storage = new PagedStorage().asBlobStorage();
    const blobs = new BlobRepositoryDouble().asBlobRepository();
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
      const storage = new PagedStorage().asBlobStorage();
      const blobs = new BlobRepositoryDouble().asBlobRepository();
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
      expect(cursors.clear).not.toHaveBeenCalledWith('change-feed-prune');
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

  const OLD = new Date(Date.now() - 2 * 3600_000);
  const FRESH = new Date();

  it('prunes expired completed mutation receipts during GC', async () => {
    const pruneExpired = jest.fn<(now: Date) => Promise<number>>().mockResolvedValue(2);
    const job = new GcJob(
      new PagedStorage().asBlobStorage(),
      new BlobRepositoryDouble().asBlobRepository(),
      makeConfig(3600),
      { pruneExpired } as unknown as VfsMutationReceiptRepository,
    );
    const result = await job.run();
    expect(result.prunedMutationReceipts).toBe(2);
    expect(pruneExpired).toHaveBeenCalledWith(expect.any(Date));
  });

  describe('orphan blob', () => {
    const row = (id: string, zeroSince: string): OrphanBlobPageRow => ({
      id,
      storageKey: `blobs/ab/${id}`,
      zeroSince,
    });

    it('스토리지 object 삭제가 실패한 blob은 metadata row를 삭제하지 않는다', async () => {
      const storage = new PagedStorage([], async (key) => {
        if (key.endsWith('blob-fail')) throw new Error('storage down');
      });
      const blobs = new BlobRepositoryDouble(new Set(), [
        row('blob-ok', '2026-01-01 00:00:00'),
        row('blob-fail', '2026-01-01 00:00:01'),
      ]);
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const result = await new GcJob(
          storage.asBlobStorage(),
          blobs.asBlobRepository(),
          makeConfig(3600),
        ).run();
        expect(result.deletedOrphanBlobs).toBe(1);
      } finally {
        log.mockRestore();
      }
      expect(blobs.deletedRows).toEqual(['blob-ok']);
    });

    it('후보를 page 단위 keyset으로 읽고 한 실행에서 실패한 행을 다시 읽지 않는다', async () => {
      const rows = Array.from({ length: 1203 }, (_, i) =>
        row(`b${String(i).padStart(4, '0')}`, '2026-01-01 00:00:00'),
      );
      const storage = new PagedStorage([], async (key) => {
        if (key.endsWith('b0000')) throw new Error('permanent');
      });
      const blobs = new BlobRepositoryDouble(new Set(), rows);
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      let result;
      try {
        result = await new GcJob(storage.asBlobStorage(), blobs.asBlobRepository(), makeConfig(3600)).run();
      } finally {
        log.mockRestore();
      }
      expect(result.deletedOrphanBlobs).toBe(1202);
      expect(blobs.orphanCalls.map((call) => call.limit)).toEqual([500, 500, 500]);
      expect(blobs.orphanCalls[0].after).toBeNull();
      expect(blobs.orphanCalls[1].after).toEqual({ zeroSince: '2026-01-01 00:00:00', id: 'b0499' });
      expect(blobs.deletedRows).not.toContain('b0000');
    });

    it('다음 실행은 처음부터 다시 읽어 실패했던 행을 재시도한다', async () => {
      let fail = true;
      const storage = new PagedStorage([], async () => {
        if (fail) throw new Error('storage down');
      });
      const blobs = new BlobRepositoryDouble(new Set(), [row('retry', '2026-01-01 00:00:00')]);
      const job = new GcJob(storage.asBlobStorage(), blobs.asBlobRepository(), makeConfig(3600));
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        expect((await job.run()).deletedOrphanBlobs).toBe(0);
        fail = false;
        expect((await job.run()).deletedOrphanBlobs).toBe(1);
      } finally {
        log.mockRestore();
      }
      expect(blobs.deletedRows).toEqual(['retry']);
    });

    describe('namespace 삭제 settle에 orphan-blobs 소진 여부를 전달한다', () => {
      function runWith(orphanCount: number) {
        const rows = Array.from({ length: orphanCount }, (_, i) =>
          row(`s${String(i).padStart(4, '0')}`, '2026-01-01 00:00:00'),
        );
        const page = { advanced: 0, completed: 0, failed: 0, examined: 0, next: null };
        const settle = jest.fn<NamespaceDeletionCleanup['settle']>().mockResolvedValue(page);
        const cleanup = {
          advance: jest.fn<NamespaceDeletionCleanup['advance']>().mockResolvedValue(page),
          settle,
        } as unknown as NamespaceDeletionCleanup;
        const config = {
          get: (key: string) => (key === 'STORIX_GC_MAX_ROWS_PER_STAGE' ? '500' : '3600'),
        } as unknown as ConfigService;
        const job = new GcJob(
          new PagedStorage().asBlobStorage(),
          new BlobRepositoryDouble(new Set(), rows).asBlobRepository(),
          config,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          cleanup,
        );
        return { job, settle };
      }

      it('orphan-blobs 단계가 예산 소진으로 멈추면 true를 전달한다', async () => {
        const { job, settle } = runWith(800);

        const result = await job.run();

        expect(result.budgetExhaustedStages).toContain('orphan-blobs');
        expect(settle.mock.calls[0][4]).toBe(true);
      });

      it('orphan-blobs 단계가 끝까지 돌면 false를 전달한다', async () => {
        const { job, settle } = runWith(10);

        const result = await job.run();

        expect(result.budgetExhaustedStages).not.toContain('orphan-blobs');
        expect(settle.mock.calls[0][4]).toBe(false);
      });
    });

    it('예산이 소진되면 cursor를 저장하고 다음 실행이 그 위치에서 이어간다', async () => {
      const rows = Array.from({ length: 800 }, (_, i) =>
        row(`c${String(i).padStart(4, '0')}`, '2026-01-01 00:00:00'),
      );
      const blobs = new BlobRepositoryDouble(new Set(), rows);
      const stored = new Map<string, string>();
      const cursors = {
        read: async (name: string) => stored.get(name) ?? null,
        write: async (name: string, position: string) => void stored.set(name, position),
        clear: async (name: string) => void stored.delete(name),
      } as unknown as GcCursorRepository;
      const failing = new PagedStorage([], async () => {
        throw new Error('storage down');
      });
      const config = {
        get: (key: string) => (key === 'STORIX_GC_MAX_ROWS_PER_STAGE' ? '500' : '3600'),
      } as unknown as ConfigService;
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const first = await new GcJob(
          failing.asBlobStorage(),
          blobs.asBlobRepository(),
          config,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          cursors,
        ).run();
        expect(first.budgetExhaustedStages).toEqual(['orphan-blobs']);
        expect(JSON.parse(stored.get('orphan-blobs')!)).toEqual({
          zeroSince: '2026-01-01 00:00:00',
          id: 'c0499',
        });
        const ok = new PagedStorage();
        const second = await new GcJob(
          ok.asBlobStorage(),
          blobs.asBlobRepository(),
          config,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          cursors,
        ).run();
        expect(blobs.orphanCalls[1].after).toEqual({
          zeroSince: '2026-01-01 00:00:00',
          id: 'c0499',
        });
        expect(second.deletedOrphanBlobs).toBe(300);
        expect(stored.has('orphan-blobs')).toBe(false);
      } finally {
        log.mockRestore();
      }
    });
  });

  describe('orphan object', () => {
    it('metadata 없이 grace period가 지난 스토리지 object만 orphan으로 센다', async () => {
      const storage = new PagedStorage([
        { key: 'blobs/ab/stale', lastModified: OLD },
        { key: 'blobs/ab/fresh', lastModified: FRESH },
        { key: 'blobs/ab/known', lastModified: OLD },
      ]);
      const blobs = new BlobRepositoryDouble(new Set(['blobs/ab/known']));
      const result = await new GcJob(
        storage.asBlobStorage(),
        blobs.asBlobRepository(),
        makeConfig(3600),
      ).run();
      expect(result.deletedOrphanObjects).toBe(1);
      expect(storage.deleted).toEqual(['blobs/ab/stale']);
    });

    it('여러 page를 순회하며 page마다 DB 대조·삭제를 하고 전체 key 집합을 만들지 않는다', async () => {
      const objects = Array.from({ length: 1200 }, (_, i) => ({
        key: `blobs/ab/${String(i).padStart(4, '0')}`,
        lastModified: OLD,
      }));
      const known = new Set(objects.filter((_, i) => i % 3 === 0).map((item) => item.key));
      const storage = new PagedStorage(objects);
      const blobs = new BlobRepositoryDouble(known);
      const result = await new GcJob(
        storage.asBlobStorage(),
        blobs.asBlobRepository(),
        makeConfig(3600),
      ).run();
      expect(result.deletedOrphanObjects).toBe(800);
      expect(
        storage.pageCalls.filter((call) => call.prefix === 'blobs/').map((call) => call.options.limit),
      ).toEqual([1000, 1000]);
      expect(blobs.findKnownStorageKeys.mock.calls.every((call) => call[0].length <= 1000)).toBe(true);
      expect(storage.deleted.some((key) => known.has(key))).toBe(false);
    });

    it('삭제에 실패한 object는 집계하지 않고 나머지를 계속 삭제한다', async () => {
      const storage = new PagedStorage(
        [
          { key: 'blobs/ab/1', lastModified: OLD },
          { key: 'blobs/ab/2', lastModified: OLD },
        ],
        async (key) => {
          if (key.endsWith('/1')) throw new Error('storage down');
        },
      );
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const result = await new GcJob(
          storage.asBlobStorage(),
          new BlobRepositoryDouble().asBlobRepository(),
          makeConfig(3600),
        ).run();
        expect(result.deletedOrphanObjects).toBe(1);
      } finally {
        log.mockRestore();
      }
    });

    it('예산이 소진되면 마지막으로 읽은 key를 저장하고 다음 실행이 그 뒤에서 이어간다', async () => {
      const objects = Array.from({ length: 1500 }, (_, i) => ({
        key: `blobs/ab/${String(i).padStart(4, '0')}`,
        lastModified: FRESH,
      }));
      const storage = new PagedStorage(objects);
      const stored = new Map<string, string>();
      const cursors = {
        read: async (name: string) => stored.get(name) ?? null,
        write: async (name: string, position: string) => void stored.set(name, position),
        clear: async (name: string) => void stored.delete(name),
      } as unknown as GcCursorRepository;
      const config = {
        get: (key: string) => (key === 'STORIX_GC_MAX_ROWS_PER_STAGE' ? '1000' : '3600'),
      } as unknown as ConfigService;
      const make = () =>
        new GcJob(
          storage.asBlobStorage(),
          new BlobRepositoryDouble().asBlobRepository(),
          config,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          cursors,
        );
      const first = await make().run();
      expect(first.budgetExhaustedStages).toEqual(['orphan-objects-blobs']);
      expect(JSON.parse(stored.get('orphan-objects-blobs')!)).toBe('blobs/ab/0999');
      const second = await make().run();
      expect(second.budgetExhaustedStages).toEqual([]);
      expect(storage.pageCalls[storage.pageCalls.length - 1].options.startAfter).toBe('blobs/ab/0999');
      expect(stored.has('orphan-objects-blobs')).toBe(false);
    });
  });

  it('expires idle sessions, recovers stale leases, retries cleanup and protects active staging keys', async () => {
    const storage = new PagedStorage(
      [
        { key: 'upload-staging/active', lastModified: OLD },
        { key: 'upload-staging/orphan', lastModified: OLD },
      ],
      async (key) => {
        if (key === 'upload-staging/cleanup') throw new Error('temporary failure');
      },
    );
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
      findKnownStagingKeys: async (keys: readonly string[]) =>
        new Set(keys.filter((key) => ['upload-staging/active', 'upload-staging/cleanup'].includes(key))),
      pruneTerminalSessions: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    };
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let result;
    try {
      result = await new GcJob(
        storage.asBlobStorage(),
        new BlobRepositoryDouble().asBlobRepository(),
        makeConfig(3600),
        undefined,
        uploads as unknown as VfsUploadSessionRepository,
      ).run();
    } finally {
      log.mockRestore();
    }
    expect(result.deletedOrphanObjects).toBe(1);
    expect(storage.deleted).not.toContain('upload-staging/active');
    expect(storage.deleted).toContain('upload-staging/orphan');
    expect(uploads.claimTerminalTransition).toHaveBeenCalledWith(
      'ns',
      'expired',
      'EXPIRED',
      expect.any(Date),
    );
    expect(uploads.markStagingObjectDeleted).not.toHaveBeenCalled();
    expect(uploads.pruneTerminalSessions).toHaveBeenCalledWith(expect.any(Date), 500);
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
      findKnownStagingKeys: async (keys: readonly string[]) => new Set(keys),
      pruneTerminalSessions: async () => 0,
    };
    const storage = new PagedStorage([], async (key) => {
      const index = Number(key.split('/')[1]);
      attempted.push(index);
      if (index < 500) throw new Error('unavailable');
    });
    const job = new GcJob(
      storage.asBlobStorage(),
      new BlobRepositoryDouble().asBlobRepository(),
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

  describe('단계 예산', () => {
    interface Deps {
      readonly uploads?: Record<string, unknown>;
      readonly receipts?: Record<string, unknown>;
      readonly trash?: Record<string, unknown>;
      readonly expiry?: Record<string, unknown>;
      readonly idempotency?: Record<string, unknown>;
      readonly purge?: Record<string, unknown>;
      readonly config?: Record<string, string>;
      readonly deletion?: Record<string, unknown>;
      readonly budget?: string;
      readonly cursors?: GcCursorRepository;
      readonly storage?: PagedStorage;
    }

    function uploadsDouble(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        recoverStaleFinalizingLeases: async () => 0,
        findExpiredOpenSessions: async () => [],
        claimTerminalTransition: async () => true,
        findExpiredReservedParts: async () => [],
        retireExpiredPartReservation: async () => true,
        findCleanupParts: async () => [],
        findCleanupTombstones: async () => [],
        markStagingObjectDeleted: async () => true,
        markTombstoneDeleted: async () => true,
        findKnownStagingKeys: async () => new Set<string>(),
        pruneTerminalSessions: async () => 0,
        ...overrides,
      };
    }

    function buildJob(deps: Deps): GcJob {
      const config = {
        get: (key: string) =>
          deps.config?.[key] ?? (key === 'STORIX_GC_MAX_ROWS_PER_STAGE' ? deps.budget : '3600'),
      } as unknown as ConfigService;
      return new GcJob(
        (deps.storage ?? new PagedStorage()).asBlobStorage(),
        new BlobRepositoryDouble().asBlobRepository(),
        config,
        deps.receipts as unknown as VfsMutationReceiptRepository,
        deps.uploads as unknown as VfsUploadSessionRepository,
        undefined,
        deps.trash as unknown as VfsTrashRetentionRepository,
        deps.expiry as unknown as VfsFileExpiryRepository,
        deps.deletion as unknown as NamespaceDeletionCleanup,
        deps.cursors,
        deps.idempotency as unknown as IdempotencyReceiptRetentionRepository,
        deps.purge as unknown as NamespacePurgeRepository,
      );
    }

    function memoryCursors() {
      const stored = new Map<string, string>();
      const repository = {
        read: async (name: string) => stored.get(name) ?? null,
        write: async (name: string, position: string) => void stored.set(name, position),
        clear: async (name: string) => void stored.delete(name),
      } as unknown as GcCursorRepository;
      return { stored, repository };
    }

    it('stale finalizing lease 복구는 batch를 이어 돌려 합산한다', async () => {
      const recover = jest
        .fn<(now: Date, batchSize: number) => Promise<number>>()
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(3);
      const result = await buildJob({
        uploads: uploadsDouble({ recoverStaleFinalizingLeases: recover }),
      }).run();
      expect(result.recoveredUploadSessions).toBe(1003);
      expect(recover).toHaveBeenCalledTimes(3);
      expect(recover).toHaveBeenCalledWith(expect.any(Date), 500);
    });

    it('mutation receipt prune은 batch가 찰 때까지 이어 돌고 예산이 소진되면 단계를 보고한다', async () => {
      const pruneExpired = jest
        .fn<(now: Date, batchSize?: number) => Promise<number>>()
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(7);
      const done = await buildJob({ receipts: { pruneExpired } }).run();
      expect(done.prunedMutationReceipts).toBe(1007);
      expect(done.budgetExhaustedStages).toEqual([]);

      const endless = jest.fn<(now: Date) => Promise<number>>().mockResolvedValue(500);
      const limited = await buildJob({ receipts: { pruneExpired: endless }, budget: '1000' }).run();
      expect(endless).toHaveBeenCalledTimes(2);
      expect(limited.prunedMutationReceipts).toBe(1000);
      expect(limited.budgetExhaustedStages).toEqual(['mutation-receipt-prune']);
    });

    it('terminal session prune도 batch를 이어 돌고 예산이 소진되면 단계를 보고한다', async () => {
      const prune = jest
        .fn<(before: Date, batchSize: number) => Promise<number>>()
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(12);
      const done = await buildJob({ uploads: uploadsDouble({ pruneTerminalSessions: prune }) }).run();
      expect(done.prunedUploadSessions).toBe(512);

      const endless = jest.fn<(before: Date, batchSize: number) => Promise<number>>().mockResolvedValue(500);
      const limited = await buildJob({
        uploads: uploadsDouble({ pruneTerminalSessions: endless }),
        budget: '500',
      }).run();
      expect(endless).toHaveBeenCalledTimes(1);
      expect(limited.budgetExhaustedStages).toEqual(['upload-session-prune']);
    });

    it('trash prune은 항목 수 예산 안에서 반복하고 소진되면 단계를 보고한다', async () => {
      const pruneExpiredBatch = jest
        .fn<(limit: number) => Promise<{ items: number; nodes: number; bytes: string; failed: number }>>()
        .mockResolvedValue({ items: 500, nodes: 500, bytes: '5', failed: 0 });
      const result = await buildJob({ trash: { pruneExpiredBatch }, budget: '1000' }).run();
      expect(pruneExpiredBatch).toHaveBeenCalledTimes(2);
      expect(result.prunedTrashItems).toBe(1000);
      expect(result.prunedTrashBytes).toBe('10');
      expect(result.failedTrashItems).toBe(0);
      expect(result.budgetExhaustedStages).toEqual(['trash-prune']);
    });

    it('trash prune에서 실패한 항목은 매 배치 다시 후보가 되므로 마지막 배치의 실패 수를 보고한다', async () => {
      const pruneExpiredBatch = jest
        .fn<(limit: number) => Promise<{ items: number; nodes: number; bytes: string; failed: number }>>()
        .mockResolvedValueOnce({ items: 3, nodes: 3, bytes: '3', failed: 1 })
        .mockResolvedValueOnce({ items: 0, nodes: 0, bytes: '0', failed: 1 });
      const result = await buildJob({ trash: { pruneExpiredBatch } }).run();
      expect(pruneExpiredBatch).toHaveBeenCalledTimes(2);
      expect(result.prunedTrashItems).toBe(3);
      expect(result.failedTrashItems).toBe(1);
      expect(result.budgetExhaustedStages).toEqual([]);
    });

    it('idempotency receipt prune은 batch를 이어 돌고 예산이 소진되면 단계를 보고한다', async () => {
      const prune = jest
        .fn<(days: number, batchSize: number) => Promise<number>>()
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(5);
      const done = await buildJob({ idempotency: { pruneExpiredBatch: prune } }).run();
      expect(done.prunedIdempotencyReceipts).toBe(505);
      expect(prune).toHaveBeenCalledWith(30, 500);

      const endless = jest.fn<(days: number, batchSize: number) => Promise<number>>().mockResolvedValue(500);
      const limited = await buildJob({ idempotency: { pruneExpiredBatch: endless }, budget: '1000' }).run();
      expect(endless).toHaveBeenCalledTimes(2);
      expect(limited.budgetExhaustedStages).toEqual(['idempotency-receipt-prune']);
    });

    it('삭제 완료 namespace 물리 삭제는 보존 기간으로 cursor를 이어 합산하고 예산이 소진되면 cursor를 저장한다', async () => {
      const cursor = { completedAt: '2026-01-01 00:00:00+00', namespaceId: 'ns-1' };
      const purgeNext = jest
        .fn<(days: number, after: unknown, limit: number) => Promise<unknown>>()
        .mockResolvedValueOnce({ purged: 98, skipped: 2, examined: 100, next: cursor })
        .mockResolvedValueOnce({ purged: 3, skipped: 0, examined: 3, next: null });
      const done = await buildJob({
        purge: { purgeNext },
        config: { STORIX_NAMESPACE_DELETED_RETENTION_DAYS: '45' },
      }).run();
      expect(done.purgedNamespaces).toBe(101);
      expect(purgeNext.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        [45, null],
        [45, cursor],
      ]);

      const memory = memoryCursors();
      const endless = jest
        .fn<(days: number, after: unknown, limit: number) => Promise<unknown>>()
        .mockResolvedValue({ purged: 0, skipped: 100, examined: 100, next: cursor });
      const limited = await buildJob({
        purge: { purgeNext: endless },
        budget: '100',
        cursors: memory.repository,
      }).run();
      expect(limited.budgetExhaustedStages).toEqual(['deleted-namespace-purge']);
      expect(JSON.parse(memory.stored.get('deleted-namespace-purge')!)).toEqual(cursor);
    });

    it('보존 기간 env가 없으면 30일이고 잘못된 값은 시작을 거부한다', () => {
      expect(resolveNamespaceDeletedRetentionDays(undefined)).toBe(30);
      expect(resolveNamespaceDeletedRetentionDays('7')).toBe(7);
      for (const invalid of ['', '0', '-1', '1.5', '1e2', ' 2', '9007199254740992'])
        expect(() => resolveNamespaceDeletedRetentionDays(invalid)).toThrow();
    });

    it('만료 파일 삭제는 cursor를 이어 합산하고 예산이 소진되면 cursor를 저장한다', async () => {
      const cursor = { expiresAt: '2026-01-01T00:00:00.000Z', id: 'n-1' };
      const expireDue = jest
        .fn<(batch: number, after: unknown) => Promise<unknown>>()
        .mockResolvedValueOnce({ files: 2, bytes: '14', examined: 500, next: cursor })
        .mockResolvedValueOnce({ files: 1, bytes: '7', examined: 3, next: null });
      const done = await buildJob({ expiry: { expireDue } }).run();
      expect(done.expiredFiles).toBe(3);
      expect(done.expiredBytes).toBe('21');
      expect(expireDue.mock.calls.map((call) => call[1])).toEqual([null, cursor]);

      const memory = memoryCursors();
      const endless = jest
        .fn<(batch: number, after: unknown) => Promise<unknown>>()
        .mockResolvedValue({ files: 0, bytes: '0', examined: 500, next: cursor });
      const limited = await buildJob({
        expiry: { expireDue: endless },
        budget: '500',
        cursors: memory.repository,
      }).run();
      expect(limited.budgetExhaustedStages).toEqual(['file-expiry']);
      expect(JSON.parse(memory.stored.get('file-expiry')!)).toEqual(cursor);
    });

    it('만료된 OPEN session은 keyset으로 이어 처리하고 성공한 전환만 센다', async () => {
      const first = Array.from({ length: 500 }, (_, i) => ({
        id: `s${String(i).padStart(3, '0')}`,
        namespaceId: 'ns',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      const find = jest
        .fn<(now: Date, batch: number, after: unknown) => Promise<typeof first>>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce([
          { id: 'last', namespaceId: 'ns', expiresAt: new Date('2026-01-02T00:00:00.000Z') },
        ]);
      const claim = jest
        .fn<(ns: string, id: string) => Promise<boolean>>()
        .mockImplementation(async (_ns, id) => id !== 's001');
      const result = await buildJob({
        uploads: uploadsDouble({ findExpiredOpenSessions: find, claimTerminalTransition: claim }),
      }).run();
      expect(result.expiredUploadSessions).toBe(500);
      expect(find.mock.calls[0][2]).toBeNull();
      expect(find.mock.calls[1][2]).toEqual({ expiresAt: '2026-01-01T00:00:00.000Z', id: 's499' });
    });

    it('staging cleanup part 순회는 예산이 소진되면 cursor를 저장한다', async () => {
      const page = Array.from({ length: 500 }, (_, i) => ({
        sessionId: 'sess',
        partIndex: i,
        stagingKey: `upload-staging/${i}`,
        state: 'CLEANUP' as const,
      }));
      const memory = memoryCursors();
      const result = await buildJob({
        uploads: uploadsDouble({ findCleanupParts: async () => page }),
        budget: '500',
        cursors: memory.repository,
      }).run();
      expect(result.deletedStagingObjects).toBe(500);
      expect(result.budgetExhaustedStages).toEqual(['staging-cleanup-parts']);
      expect(JSON.parse(memory.stored.get('staging-cleanup-parts')!)).toEqual({
        sessionId: 'sess',
        partIndex: 499,
      });
    });

    it('namespace 삭제 advance·settle은 page 단위로 이어 돌고 결과를 합산한다', async () => {
      const advance = jest
        .fn<(now: Date, after: string | null, limit: number) => Promise<unknown>>()
        .mockResolvedValueOnce({ advanced: 2, completed: 0, failed: 1, examined: 100, next: 'ns-100' })
        .mockResolvedValueOnce({ advanced: 1, completed: 0, failed: 0, examined: 4, next: null });
      const settle = jest
        .fn<(cutoff: Date, now: Date, after: string | null, limit: number) => Promise<unknown>>()
        .mockResolvedValueOnce({ advanced: 0, completed: 3, failed: 2, examined: 100, next: 'ns-9' })
        .mockResolvedValueOnce({ advanced: 0, completed: 1, failed: 0, examined: 1, next: null });
      const result = await buildJob({ deletion: { advance, settle } }).run();
      expect(result.advancedNamespaceDeletions).toBe(3);
      expect(result.completedNamespaceDeletions).toBe(4);
      expect(result.failedNamespaceDeletions).toBe(3);
      expect(advance.mock.calls.map((call) => call[1])).toEqual([null, 'ns-100']);
      expect(settle.mock.calls.map((call) => call[2])).toEqual([null, 'ns-9']);
    });
  });
});
