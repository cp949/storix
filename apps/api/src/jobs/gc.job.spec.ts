import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { GcJob } from './gc.job.js';
import type { BlobRepository, OrphanBlobRow } from '../persistence/blob.repository.js';
import type { BlobObjectInfo, BlobStorage } from '../storage/blob-storage.js';
import type { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import type { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';

describe('GcJob', () => {
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

  it('MinIO object 삭제가 실패한 blob은 metadata row를 삭제하지 않는다', async () => {
    const deleteMock = jest
      .fn<(key: string) => Promise<void>>()
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error('minio down')));
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

  it('metadata 없이 grace period가 지난 MinIO object만 orphan으로 센다', async () => {
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
    const deleteObject = jest.fn<(key: string) => Promise<void>>()
      .mockImplementation(async (key) => {
        if (key === 'upload-staging/cleanup') throw new Error('temporary failure');
      });
    const uploads = {
      recoverStaleFinalizingLeases: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      findExpiredOpenSessions: jest.fn<() => Promise<Array<{ namespaceId: string; id: string }>>>()
        .mockResolvedValue([{ namespaceId: 'ns', id: 'expired' }]),
      claimTerminalTransition: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findCleanupParts: jest.fn<() => Promise<Array<{ sessionId: string; partIndex: number; stagingKey: string; state: 'CLEANUP' }>>>()
        .mockResolvedValue([{ sessionId: 'expired', partIndex: 0, stagingKey: 'upload-staging/cleanup', state: 'CLEANUP' }]),
      markStagingObjectDeleted: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findAllStagingKeys: jest.fn<() => Promise<Set<string>>>().mockResolvedValue(new Set(['upload-staging/active', 'upload-staging/cleanup'])),
      pruneTerminalSessions: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    };
    const job = new GcJob(
      { list, delete: deleteObject } as unknown as BlobStorage,
      {
        findAllStorageKeys: async () => new Set<string>(),
        findOrphanBlobs: async () => [],
        deleteBlobRows: async () => undefined,
      } as unknown as BlobRepository,
      makeConfig(3600), undefined, uploads as unknown as VfsUploadSessionRepository,
    );
    const result = await job.run();
    expect(result.deletedOrphanObjects).toBe(1);
    expect(deleteObject).not.toHaveBeenCalledWith('upload-staging/active');
    expect(deleteObject).toHaveBeenCalledWith('upload-staging/orphan');
    expect(uploads.claimTerminalTransition).toHaveBeenCalledWith('ns', 'expired', 'EXPIRED', expect.any(Date));
    expect(uploads.markStagingObjectDeleted).not.toHaveBeenCalled();
    expect(uploads.pruneTerminalSessions).toHaveBeenCalledWith(expect.any(Date));
  });

  it('continues past 500 failed cleanup candidates to a later part', async () => {
    const all = Array.from({ length: 501 }, (_, partIndex) => ({
      sessionId: 'session', partIndex, stagingKey: `upload-staging/${partIndex}`, state: 'CLEANUP' as const,
    }));
    const attempted: number[] = [];
    const marked: number[] = [];
    const uploads = {
      recoverStaleFinalizingLeases: async () => 0,
      findExpiredOpenSessions: async () => [],
      findCleanupParts: async (cursor?: { sessionId: string; partIndex: number } | null, batchSize = 500) =>
        all.filter((part) => cursor === undefined || cursor === null || part.partIndex > cursor.partIndex)
          .slice(0, batchSize),
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
    const job = new GcJob(storage as unknown as BlobStorage, blobs as unknown as BlobRepository,
      makeConfig(3600), undefined, uploads as unknown as VfsUploadSessionRepository);
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
