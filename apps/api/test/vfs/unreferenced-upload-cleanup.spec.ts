import { jest } from '@jest/globals';
import { StorageUnavailableError } from '../../src/common/storage-failure.errors.js';
import { deleteUnreferencedUpload } from '../../src/vfs/unreferenced-upload-cleanup.js';
import { VfsVersionConflictError } from '../../src/vfs/vfs.errors.js';

describe('deleteUnreferencedUpload', () => {
  const KEY = 'ns/key-1';
  let findKnownStorageKeys: jest.Mock<(keys: readonly string[]) => Promise<Set<string>>>;
  let remove: jest.Mock<(key: string) => Promise<void>>;

  beforeEach(() => {
    findKnownStorageKeys = jest.fn<(keys: readonly string[]) => Promise<Set<string>>>();
    remove = jest.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
  });

  const run = (error: unknown) =>
    deleteUnreferencedUpload({ findKnownStorageKeys }, { delete: remove }, KEY, error);

  it('Blob row가 없고 4xx DomainError면 object를 삭제한다', async () => {
    findKnownStorageKeys.mockResolvedValue(new Set());

    await run(new VfsVersionConflictError('/a'));

    expect(remove).toHaveBeenCalledWith(KEY);
  });

  it('Blob row가 object를 참조하면 삭제하지 않는다', async () => {
    findKnownStorageKeys.mockResolvedValue(new Set([KEY]));

    await run(new VfsVersionConflictError('/a'));

    expect(remove).not.toHaveBeenCalled();
  });

  it('참조 확인이 실패하면 삭제하지 않는다', async () => {
    findKnownStorageKeys.mockRejectedValue(new Error('db down'));

    await run(new VfsVersionConflictError('/a'));

    expect(remove).not.toHaveBeenCalled();
  });

  it('5xx DomainError면 삭제하지 않는다', async () => {
    findKnownStorageKeys.mockResolvedValue(new Set());

    await run(new StorageUnavailableError());

    expect(remove).not.toHaveBeenCalled();
  });

  it('DomainError가 아닌 오류면 삭제하지 않는다', async () => {
    findKnownStorageKeys.mockResolvedValue(new Set());

    await run(new Error('unknown'));

    expect(remove).not.toHaveBeenCalled();
  });

  it('삭제가 실패해도 오류를 전파하지 않는다', async () => {
    findKnownStorageKeys.mockResolvedValue(new Set());
    remove.mockRejectedValue(new Error('s3 down'));

    await expect(run(new VfsVersionConflictError('/a'))).resolves.toBeUndefined();
  });
});
