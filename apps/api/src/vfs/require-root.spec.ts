import { jest } from '@jest/globals';
import { VfsNodeRecord, VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { requireRoot } from './require-root.js';
import { VfsNamespaceNotFoundError } from './vfs.errors.js';

describe('requireRoot', () => {
  it('UUID 형식이 아니면 repository 조회 없이 VfsNamespaceNotFoundError를 던진다', async () => {
    const repo = { getRoot: jest.fn() } as unknown as VfsNodeRepository;

    await expect(requireRoot(repo, 'not-a-uuid')).rejects.toThrow(VfsNamespaceNotFoundError);
    expect((repo as unknown as { getRoot: jest.Mock }).getRoot).not.toHaveBeenCalled();
  });

  it('namespace가 없으면 VfsNamespaceNotFoundError를 던진다', async () => {
    const repo = {
      getRoot: jest.fn<(namespaceId: string) => Promise<VfsNodeRecord | null>>().mockResolvedValue(null),
    } as unknown as VfsNodeRepository;

    await expect(requireRoot(repo, '11111111-1111-1111-1111-111111111111')).rejects.toThrow(
      VfsNamespaceNotFoundError,
    );
  });

  it('namespace가 있으면 root record를 반환한다', async () => {
    const root: VfsNodeRecord = {
      id: 'root',
      name: '',
      type: 'DIRECTORY',
      blobId: null,
      size: null,
      mimeType: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };
    const repo = {
      getRoot: jest.fn<(namespaceId: string) => Promise<VfsNodeRecord | null>>().mockResolvedValue(root),
    } as unknown as VfsNodeRepository;

    const result = await requireRoot(repo, '11111111-1111-1111-1111-111111111111');

    expect(result).toBe(root);
  });
});
