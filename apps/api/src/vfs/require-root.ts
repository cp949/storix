import { isUuid } from '../common/uuid.js';
import { NamespaceResourceLimits, VfsNodeRecord, VfsNodeRepository } from '../persistence/vfs-node.repository.js';
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

export async function requireRootWithLimits(
  repo: VfsNodeRepository,
  namespaceId: string,
): Promise<{ root: VfsNodeRecord; limits: NamespaceResourceLimits }> {
  if (!isUuid(namespaceId)) {
    throw new VfsNamespaceNotFoundError(namespaceId);
  }

  const result = await repo.getRootWithLimits(namespaceId);
  if (!result) {
    throw new VfsNamespaceNotFoundError(namespaceId);
  }

  return result;
}
