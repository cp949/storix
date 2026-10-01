import { classifyPersistenceOperation } from './persistence-failure.js';
import { IsNull } from 'typeorm';
import {
  VfsDirectoryNotEmptyError,
  VfsDeleteLimitExceededError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsPreconditionFailedError,
  VfsRevisionExhaustedError,
  VfsTrashItemExpiredError,
} from '../vfs/vfs.errors.js';
import { decodeRevision, MAX_VFS_VERSION } from '../vfs/revision.js';
import { assertPathSegments } from '../vfs/path-resolver.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import type { MutationTx, SnapshotSourceRow, VfsNodeRecord } from './vfs-node.repository.types.js';
import { joinSegments, toRecord } from './vfs-node.repository.helpers.js';
import { VfsNodeRepositoryTreeMutations } from './vfs-node.repository.tree-mutations.js';
import { trackChangeFeedBefore } from './vfs-change-feed-journal.js';
import { VfsTrashRepository } from './vfs-trash.repository.js';

export class VfsNodeRepositoryTrash extends VfsNodeRepositoryTreeMutations {
  protected trashRepository: VfsTrashRepository;

  // 후보 조회 뒤 경로나 만료 상태가 바뀔 수 있어 root 잠금 안에서 다시 확인한다.
  @classifyPersistenceOperation
  async expireNode(namespaceId: string, nodeId: string, cutoff: Date): Promise<{ size: string } | null> {
    const root = await this.nodeRepo.findOneBy({ namespaceId, parentId: IsNull() });
    if (!root) return null;
    const { value } = await this.withMutation(
      namespaceId,
      root.id,
      async (tx) => {
        const nodes = tx.manager.getRepository(VfsNodeEntity);
        const namespace = await tx.manager.getRepository(NamespaceEntity).findOneBy({ id: namespaceId });
        if (namespace?.status !== 'ACTIVE') return null;
        const node = await nodes.findOneBy({ id: nodeId, namespaceId });
        if (!node) return null;
        const segments: string[] = [];
        let current: VfsNodeEntity = node;
        while (current.parentId) {
          segments.unshift(current.name);
          const parent = await nodes.findOneBy({ id: current.parentId, namespaceId });
          if (!parent) throw new Error('VFS parent node missing');
          current = parent;
        }
        if (current.id !== root.id) throw new Error('VFS root node mismatch');
        const parentId = await this.lockParentChain(
          tx.manager,
          namespaceId,
          root.id,
          segments,
          false,
          tx,
          false,
        );
        const target = await this.lockTargetNode(tx.manager, namespaceId, parentId, segments.at(-1)!, tx);
        if (!target || target.id !== nodeId || target.type !== 'FILE' || target.expiresAt === null)
          return null;
        if (target.expiresAt.getTime() > cutoff.getTime()) return null;
        await this.removeNode(namespaceId, root.id, segments, false, 1, tx);
        return { size: String(target.size) };
      },
      undefined,
      { allowInactive: true },
    );
    return value;
  }

  // 구체 VfsNodeRepository 생성자가 휴지통 저장소를 주입한다.
  protected setTrashRepository(trash: VfsTrashRepository): void {
    this.trashRepository = trash;
  }

  @classifyPersistenceOperation
  async restoreTrashItem(
    namespaceId: string,
    trashId: string,
    targetPath?: string,
    tx?: MutationTx,
  ): Promise<{ trashId: string; node: VfsNodeRecord; path: string }> {
    if (!tx) {
      const root = await this.nodeRepo.findOneBy({ namespaceId, parentId: IsNull() });
      if (!root) throw new VfsNodeNotFoundError('/');
      return (
        await this.withMutation(namespaceId, root.id, (inner) =>
          this.restoreTrashItem(namespaceId, trashId, targetPath, inner),
        )
      ).value;
    }
    const item = await this.trashRepository.findForMutation(tx, trashId);
    if (item.expired) throw new VfsTrashItemExpiredError(trashId);
    const path = targetPath ?? item.trash.originalPath;
    const segments = path.split('/').filter(Boolean);
    assertPathSegments(segments);
    if (segments.length === 0) throw new VfsNodeNotFoundError(path);
    const parentId = await this.lockParentChain(tx.manager, namespaceId, tx.rootId, segments, false, tx);
    const collision = await this.lockTargetNode(tx.manager, namespaceId, parentId, segments.at(-1)!, tx);
    if (collision) throw new VfsPreconditionFailedError(path, this.currentOf(collision, path));

    const depth = (path: string) => (path === '.' ? 0 : path.split('/').length);
    const entries = [...item.entries].sort(
      (left, right) =>
        depth(left.relativePath) - depth(right.relativePath) ||
        (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
    );
    if (entries[0]?.relativePath !== '.') throw new Error('Trash manifest root missing');
    const restored = new Map<string, string>();
    let bytes = 0n;
    const repo = tx.manager.getRepository(VfsNodeEntity);
    for (const entry of entries) {
      const relative = entry.relativePath === '.' ? [] : entry.relativePath.split('/');
      assertPathSegments([...segments, ...relative]);
      const parentRelative = relative.slice(0, -1).join('/') || '.';
      const nodeParentId = relative.length === 0 ? parentId : restored.get(parentRelative);
      if (!nodeParentId) throw new Error('Trash manifest parent missing');
      const source = decodeRevision(entry.sourceRevision);
      if (source.id !== entry.sourceNodeId || source.version >= MAX_VFS_VERSION)
        throw new VfsRevisionExhaustedError();
      if (entry.type === 'FILE') {
        if (!entry.blobId || entry.size === null || entry.mimeType === null)
          throw new Error('Trash FILE metadata missing');
        bytes += BigInt(String(entry.size));
      }
      await repo.insert({
        id: entry.sourceNodeId,
        namespaceId,
        parentId: nodeParentId,
        name: relative.length === 0 ? segments.at(-1)! : relative.at(-1)!,
        type: entry.type,
        blobId: entry.blobId,
        size: entry.size,
        mimeType: entry.mimeType,
        version: source.version + 1,
      });
      restored.set(entry.relativePath, entry.sourceNodeId);
      this.markChanged(tx, entry.sourceNodeId, false);
    }
    if (bytes !== BigInt(String(item.trash.logicalBytes)))
      throw new Error('Trash manifest byte count mismatch');
    await this.trashRepository.consume(tx, item);
    this.recordLiveByteDelta(tx, bytes);
    const root = await repo.findOneByOrFail({ id: item.trash.rootNodeId, namespaceId });
    return { trashId, node: toRecord(root), path };
  }

  @classifyPersistenceOperation
  async purgeTrashItem(
    namespaceId: string,
    trashId: string,
    tx?: MutationTx,
  ): Promise<{ trashId: string; purged: true }> {
    if (!tx) {
      const root = await this.nodeRepo.findOneBy({ namespaceId, parentId: IsNull() });
      if (!root) throw new VfsNodeNotFoundError('/');
      return (
        await this.withMutation(namespaceId, root.id, (inner) =>
          this.purgeTrashItem(namespaceId, trashId, inner),
        )
      ).value;
    }
    const item = await this.trashRepository.findForMutation(tx, trashId);
    const counts = new Map<string, number>();
    let bytes = 0n;
    for (const entry of item.entries) {
      if (entry.type === 'FILE') {
        if (!entry.blobId || entry.size === null) throw new Error('Trash FILE metadata missing');
        bytes += BigInt(String(entry.size));
        counts.set(entry.blobId, (counts.get(entry.blobId) ?? 0) + 1);
      }
    }
    if (bytes !== BigInt(String(item.trash.logicalBytes)))
      throw new Error('Trash manifest byte count mismatch');
    await this.trashRepository.consume(tx, item);
    for (const [blobId, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
      await this.blobRepository.decrementReferenceCount(tx.manager, blobId, count);
    }
    return { trashId, purged: true };
  }

  @classifyPersistenceOperation
  async removeNode(
    namespaceId: string,
    rootId: string,
    segments: string[],
    recursive: boolean,
    maxSyncDeleteNodes: number,
    tx?: MutationTx,
  ): Promise<string | null> {
    if (!tx)
      return (
        await this.withMutation(namespaceId, rootId, (inner) =>
          this.removeNode(namespaceId, rootId, segments, recursive, maxSyncDeleteNodes, inner),
        )
      ).value;
    const manager = tx.manager;
    const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, false, tx);
    const target = await this.lockTargetNode(manager, namespaceId, parentId, segments.at(-1)!, tx);
    if (!target) throw new VfsNodeNotFoundError(joinSegments(segments));
    if (target.type === 'DIRECTORY' && !recursive) throw new VfsIsDirectoryError(joinSegments(segments));

    // 하위 트리의 모든 mutation은 target을 통과하므로 target 잠금이 하위 행 구성도 고정한다.
    const rows = await this.captureSnapshotRows(
      tx,
      segments,
      target.type === 'FILE' ? 1 : maxSyncDeleteNodes,
    );
    if (rows.length > maxSyncDeleteNodes && target.type === 'DIRECTORY')
      throw new VfsDeleteLimitExceededError(maxSyncDeleteNodes);
    return this.moveToTrash(tx, segments, rows);
  }

  @classifyPersistenceOperation
  async removeEmptyDirectory(
    namespaceId: string,
    rootId: string,
    segments: string[],
    tx?: MutationTx,
  ): Promise<string | null> {
    if (!tx)
      return (
        await this.withMutation(namespaceId, rootId, (inner) =>
          this.removeEmptyDirectory(namespaceId, rootId, segments, inner),
        )
      ).value;
    const manager = tx.manager;
    const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, false, tx);
    const target = await this.lockTargetNode(manager, namespaceId, parentId, segments.at(-1)!, tx);
    if (!target) throw new VfsNodeNotFoundError(joinSegments(segments));
    if (target.type === 'FILE') throw new VfsNotDirectoryError(joinSegments(segments));
    const children = await manager.getRepository(VfsNodeEntity).countBy({ namespaceId, parentId: target.id });
    if (children > 0) throw new VfsDirectoryNotEmptyError(joinSegments(segments));
    return this.moveToTrash(tx, segments, await this.captureSnapshotRows(tx, segments, 1));
  }

  private async moveToTrash(
    tx: MutationTx,
    segments: string[],
    rows: readonly SnapshotSourceRow[],
  ): Promise<string | null> {
    await trackChangeFeedBefore(
      tx,
      rows.map((row) => row.id),
    );
    const namespace = await tx.manager.getRepository(NamespaceEntity).findOneByOrFail({ id: tx.namespaceId });
    const blobCounts = new Map<string, number>();
    let removedBytes = 0n;
    for (const row of rows) {
      if (row.type === 'FILE') {
        removedBytes += BigInt(row.size!);
        blobCounts.set(row.blobId!, (blobCounts.get(row.blobId!) ?? 0) + 1);
      }
    }
    const sorted = [...blobCounts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (!namespace.trashEnabled) {
      await tx.manager.getRepository(VfsNodeEntity).delete(rows.map((row) => row.id));
      this.recordLiveByteDelta(tx, -removedBytes);
      for (const [blobId, count] of sorted)
        await this.blobRepository.decrementReferenceCount(tx.manager, blobId, count);
      return null;
    }

    const trashId = await this.trashRepository.capture(tx, joinSegments(segments), rows);
    for (const [blobId, count] of sorted) {
      if (!(await this.blobRepository.incrementLiveReferenceCount(tx.manager, tx.namespaceId, blobId, count)))
        throw new Error('Trash source Blob is not live');
    }
    await tx.manager.getRepository(VfsNodeEntity).delete(rows.map((row) => row.id));
    this.recordLiveByteDelta(tx, -removedBytes);
    for (const [blobId, count] of sorted)
      await this.blobRepository.decrementReferenceCount(tx.manager, blobId, count);
    return trashId;
  }
}
