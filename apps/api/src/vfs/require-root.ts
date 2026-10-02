import { isNamespaceId } from '../common/namespace-id.js';
import {
  NamespaceResourceLimits,
  VfsNodeRecord,
  VfsNodeRepository,
} from '../persistence/vfs-node.repository.js';
import { VfsNamespaceNotFoundError } from './vfs.errors.js';

export async function requireRoot(repo: VfsNodeRepository, namespaceId: string): Promise<VfsNodeRecord> {
  if (!isNamespaceId(namespaceId)) {
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
  if (!isNamespaceId(namespaceId)) {
    throw new VfsNamespaceNotFoundError(namespaceId);
  }

  const result = await repo.getRootWithLimits(namespaceId);
  if (!result) {
    throw new VfsNamespaceNotFoundError(namespaceId);
  }

  return result;
}
