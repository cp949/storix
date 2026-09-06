import { isUuid } from '../common/uuid.js';
import { VfsNodeRecord, VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsNamespaceNotFoundError } from './vfs.errors.js';

export async function requireRoot(repo: VfsNodeRepository, namespaceId: string): Promise<VfsNodeRecord> {
  if (!isUuid(namespaceId)) {
    throw new VfsNamespaceNotFoundError(namespaceId);
  }

  const root = await repo.getRoot(namespaceId);
  if (!root) {
    throw new VfsNamespaceNotFoundError(namespaceId);
  }

  return root;
}
