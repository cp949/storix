import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { GcJob } from './gc.job.js';
import type { BlobRepository, OrphanBlobRow } from '../persistence/blob.repository.js';
import type { BlobObjectInfo, BlobStorage } from '../storage/blob-storage.js';

describe('GcJob', () => {
  function makeConfig(gracePeriodSeconds: number): ConfigService {
    return { get: () => String(gracePeriodSeconds) } as unknown as ConfigService;
  }

  async function* emptyList(): AsyncIterable<BlobObjectInfo> {}

  it('MinIO object 삭제가 실패한 blob은 metadata row를 삭제하지 않는다', async () => {
    const deleteMock = jest
      .fn<(key: string) => Promise<void>>()
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error('minio down')));
    const storage: Pick<BlobStorage, 'list' | 'delete'> = {
      list: emptyList,
      delete: deleteMock,
    };
    const findOrphanBlobs = jest
      .fn<(cutoff: Date) => Promise<OrphanBlobRow[]>>()
      .mockResolvedValue([
        { id: 'blob-ok', storageKey: 'blobs/ab/ok' },
        { id: 'blob-fail', storageKey: 'blobs/ab/fail' },
      ]);
    const deleteBlobRows = jest.fn<(ids: string[]) => Promise<void>>().mockResolvedValue(undefined);
    const blobRepository: Pick<BlobRepository, 'findAllStorageKeys' | 'findOrphanBlobs' | 'deleteBlobRows'> = {
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
    const blobRepository: Pick<BlobRepository, 'findAllStorageKeys' | 'findOrphanBlobs' | 'deleteBlobRows'> = {
      findAllStorageKeys: jest.fn<() => Promise<Set<string>>>().mockResolvedValue(new Set(['blobs/ab/known'])),
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
});
