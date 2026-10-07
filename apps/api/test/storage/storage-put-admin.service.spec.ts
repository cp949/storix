import { describe, expect, it, jest } from '@jest/globals';
import type { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { StoragePutAdminService } from '../../src/storage/storage-put-admin.service.js';

// 가짜 S3와 owner table로 legacy manifest의 필터·digest·정확한 abort 대상을 확인한다.
describe('StoragePutAdminService', () => {
  it('미등록 Storix multipart만 정확한 manifest에 담고 digest를 계산한다', async () => {
    const storage = {
      listIncompleteUploadsPage: jest.fn<BlobStorage['listIncompleteUploadsPage']>(async (prefix) => ({
        items:
          prefix === 'blobs/'
            ? [
                { key: 'blobs/legacy', uploadId: 'upload-1', initiated: new Date('2026-01-01T00:00:00Z') },
                {
                  key: 'blobs/registered',
                  uploadId: 'upload-registered',
                  initiated: new Date('2026-01-01T00:00:00Z'),
                },
              ]
            : [
                {
                  key: 'upload-staging/legacy',
                  uploadId: 'upload-2',
                  initiated: new Date('2026-01-02T00:00:00Z'),
                },
              ],
        next: null,
      })),
      abortIncompleteUpload: jest.fn<BlobStorage['abortIncompleteUpload']>().mockResolvedValue(undefined),
    };
    const ownership = {
      hasKeyRecord: jest.fn<StoragePutOwnershipRepository['hasKeyRecord']>(async (key) =>
        key.endsWith('registered'),
      ),
    };
    const service = new StoragePutAdminService(storage as never, ownership as never);

    const manifest = await service.createLegacyManifest();

    expect(manifest.uploads.map(({ key, uploadId }) => [key, uploadId])).toEqual([
      ['blobs/legacy', 'upload-1'],
      ['upload-staging/legacy', 'upload-2'],
    ]);
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.abortLegacyManifest(manifest, manifest.sha256)).resolves.toBe(2);
    expect(storage.abortIncompleteUpload).toHaveBeenCalledTimes(2);
    expect(storage.abortIncompleteUpload).toHaveBeenCalledWith('blobs/legacy', 'upload-1');
    expect(storage.abortIncompleteUpload).toHaveBeenCalledWith('upload-staging/legacy', 'upload-2');
  });

  it('digest 불일치면 manifest의 어느 upload도 abort하지 않는다', async () => {
    const storage = {
      listIncompleteUploadsPage: jest.fn<BlobStorage['listIncompleteUploadsPage']>(),
      abortIncompleteUpload: jest.fn<BlobStorage['abortIncompleteUpload']>().mockResolvedValue(undefined),
    };
    const ownership = { hasKeyRecord: jest.fn<StoragePutOwnershipRepository['hasKeyRecord']>() };
    const service = new StoragePutAdminService(storage as never, ownership as never);

    await expect(
      service.abortLegacyManifest(
        { uploads: [{ key: 'blobs/legacy', uploadId: 'u', initiated: '' }] },
        '0'.repeat(64),
      ),
    ).rejects.toThrow('manifest SHA-256 불일치');
    expect(storage.abortIncompleteUpload).not.toHaveBeenCalled();
  });
});
