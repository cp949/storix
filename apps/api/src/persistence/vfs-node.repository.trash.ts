import { classifyPersistenceOperation } from './persistence-failure.js';
import { VfsDirectoryNotEmptyError, VfsDeleteLimitExceededError, VfsIsDirectoryError, VfsNodeNotFoundError, VfsNotDirectoryError } from '../vfs/vfs.errors.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import type { MutationTx, SnapshotSourceRow } from './vfs-node.repository.types.js';
import { joinSegments } from './vfs-node.repository.helpers.js';
import { VfsNodeRepositoryTreeMutations } from './vfs-node.repository.tree-mutations.js';
import { trackChangeFeedBefore } from './vfs-change-feed-journal.js';
import { VfsTrashRepository } from './vfs-trash.repository.js';

export class VfsNodeRepositoryTrash extends VfsNodeRepositoryTreeMutations {
  protected trashRepository: VfsTrashRepository;

  // 구체 VfsNodeRepository 생성자가 휴지통 저장소를 주입한다.
  protected setTrashRepository(trash: VfsTrashRepository): void {
    this.trashRepository = trash;
  }

  @classifyPersistenceOperation
  async removeNode(
    namespaceId: string,
    rootId: string,
    segments: string[],
    recursive: boolean,
    maxSyncDeleteNodes: number,
    tx?: MutationTx,
  ): Promise<string> {
    if (!tx) return (await this.withMutation(namespaceId, rootId, (inner) =>
      this.removeNode(namespaceId, rootId, segments, recursive, maxSyncDeleteNodes, inner))).value;
    const manager = tx.manager;
    const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, false, tx);
    const target = await this.lockTargetNode(manager, namespaceId, parentId, segments.at(-1)!, tx);
    if (!target) throw new VfsNodeNotFoundError(joinSegments(segments));
    if (target.type === 'DIRECTORY' && !recursive) throw new VfsIsDirectoryError(joinSegments(segments));

    // 하위 트리의 모든 mutation은 target을 통과하므로 target 잠금이 하위 행 구성도 고정한다.
    const rows = await this.captureSnapshotRows(tx, segments, target.type === 'FILE' ? 1 : maxSyncDeleteNodes);
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
  ): Promise<string> {
    if (!tx) return (await this.withMutation(namespaceId, rootId, (inner) =>
      this.removeEmptyDirectory(namespaceId, rootId, segments, inner))).value;
    const manager = tx.manager;
    const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, false, tx);
    const target = await this.lockTargetNode(manager, namespaceId, parentId, segments.at(-1)!, tx);
    if (!target) throw new VfsNodeNotFoundError(joinSegments(segments));
    if (target.type === 'FILE') throw new VfsNotDirectoryError(joinSegments(segments));
    const children = await manager.getRepository(VfsNodeEntity).countBy({ namespaceId, parentId: target.id });
    if (children > 0) throw new VfsDirectoryNotEmptyError(joinSegments(segments));
    return this.moveToTrash(tx, segments, await this.captureSnapshotRows(tx, segments, 1));
  }

  private async moveToTrash(tx: MutationTx, segments: string[], rows: readonly SnapshotSourceRow[]): Promise<string> {
    await trackChangeFeedBefore(tx, rows.map((row) => row.id));
    const trashId = await this.trashRepository.capture(tx, joinSegments(segments), rows);
    const blobCounts = new Map<string, number>();
    let removedBytes = 0n;
    for (const row of rows) {
      if (row.type === 'FILE') {
        removedBytes += BigInt(row.size!);
        blobCounts.set(row.blobId!, (blobCounts.get(row.blobId!) ?? 0) + 1);
      }
    }
    const sorted = [...blobCounts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (const [blobId, count] of sorted) {
      if (!(await this.blobRepository.incrementLiveReferenceCount(tx.manager, tx.namespaceId, blobId, count)))
        throw new Error('Trash source Blob is not live');
    }
    await tx.manager.getRepository(VfsNodeEntity).delete(rows.map((row) => row.id));
    this.recordLiveByteDelta(tx, -removedBytes);
    for (const [blobId, count] of sorted) await this.blobRepository.decrementReferenceCount(tx.manager, blobId, count);
    return trashId;
  }
}
