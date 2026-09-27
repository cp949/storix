import { randomUUID } from 'node:crypto';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import { VfsCopyLimitExceededError } from '../vfs/vfs.errors.js';
import { BlobEntity } from './entities/blob.entity.js';
import { VfsNodeEntity, VfsNodeType } from './entities/vfs-node.entity.js';
import type { VfsNodeRecord, MutationTx, CopySourceRow } from './vfs-node.repository.types.js';
import { assertSubtreeDestinationPaths, toRecord, joinSegments } from './vfs-node.repository.helpers.js';
import { VfsNodeRepositoryFileMutations } from './vfs-node.repository.file-mutations.js';

export class VfsNodeRepositoryTreeMutations extends VfsNodeRepositoryFileMutations {
  @classifyPersistenceOperation
  async copyNode(
    namespaceId: string,
    rootId: string,
    sourceSegments: string[],
    destinationSegments: string[],
    destinationParents: boolean,
    maxSyncCopyNodes: number,
    tx?: MutationTx,
    destinationResolution?: 'exact',
  ): Promise<{ node: VfsNodeRecord; finalPath: string }> {
    if (!tx) {
      return (
        await this.withMutation(namespaceId, rootId, (inner) =>
          this.copyNode(
            namespaceId,
            rootId,
            sourceSegments,
            destinationSegments,
            destinationParents,
            maxSyncCopyNodes,
            inner,
            destinationResolution,
          ),
        )
      ).value;
    }
    const manager = tx.manager;
    const nodeRepo = manager.getRepository(VfsNodeEntity);
    const blobRepo = manager.getRepository(BlobEntity);

    const { sourceNode, finalParentId, finalName, finalSegments } = await this.resolveDestinationPlacement(
      manager,
      namespaceId,
      rootId,
      sourceSegments,
      destinationSegments,
      destinationParents,
      tx,
      false,
      destinationResolution,
    );

    if (sourceNode.type === 'FILE') {
      if (!sourceNode.blobId) {
        throw new Error('FILE node에 blobId가 없음 — 데이터 일관성 위반');
      }

      // COW: MinIO I/O 없이 같은 Blob을 가리키는 새 Node만 만들고 참조 수를 늘린다.
      await blobRepo.increment({ id: sourceNode.blobId }, 'referenceCount', 1);
      const created = await nodeRepo.save(
        nodeRepo.create({
          namespaceId,
          parentId: finalParentId,
          type: 'FILE',
          name: finalName,
          blobId: sourceNode.blobId,
          size: sourceNode.size,
          mimeType: sourceNode.mimeType,
        }),
      );
      this.markChanged(tx, created.id, false);
      if (sourceNode.size === null) throw new Error('FILE node에 size가 없음 — 데이터 일관성 위반');
      this.recordLiveByteDelta(tx, BigInt(sourceNode.size));

      return { node: toRecord(created), finalPath: joinSegments(finalSegments) };
    }

    // DIRECTORY: resolveDestinationPlacement 안에서 source 자신의 row lock을 이미
    // 획득했으므로(removeNode와 동일 원리), 아래 조회~생성 사이에 source subtree
    // 구성이 바뀔 수 없다.
    const ph = new DialectPlaceholders(this.isSqlite);
    const subtreeRows: CopySourceRow[] = await manager.query(
      `WITH RECURSIVE subtree AS (
           SELECT id, parent_id, type, name, blob_id, size, mime_type
           FROM vfs_node WHERE id = ${ph.bind(sourceNode.id)} AND namespace_id = ${ph.bind(namespaceId)}
           UNION ALL
           SELECT vn.id, vn.parent_id, vn.type, vn.name, vn.blob_id, vn.size, vn.mime_type
           FROM vfs_node vn
           INNER JOIN subtree s ON vn.namespace_id = ${ph.bind(namespaceId)} AND vn.parent_id = s.id
         )
         SELECT id, parent_id, type, name, blob_id, size, mime_type FROM subtree LIMIT ${ph.bind(maxSyncCopyNodes + 1)}`,
      ph.params,
    );

    if (subtreeRows.length > maxSyncCopyNodes) {
      throw new VfsCopyLimitExceededError(maxSyncCopyNodes);
    }
    assertSubtreeDestinationPaths(sourceNode.id, finalSegments, subtreeRows);

    const childrenByParent = new Map<string, CopySourceRow[]>();
    for (const row of subtreeRows) {
      if (row.id === sourceNode.id) {
        continue;
      }
      const siblings = childrenByParent.get(row.parent_id as string) ?? [];
      siblings.push(row);
      childrenByParent.set(row.parent_id as string, siblings);
    }

    const newRoot = await nodeRepo.save(
      nodeRepo.create({ namespaceId, parentId: finalParentId, type: 'DIRECTORY', name: finalName }),
    );
    this.markChanged(tx, newRoot.id, false);

    // 자식마다 save()를 순차 await하면 상한(최대 maxSyncCopyNodes)만큼 DB 왕복이
    // 발생하는 동안 lockParentChain이 잡은 namespace root lock을 계속 붙들고 있어
    // 같은 namespace의 다른 모든 mutation을 그만큼 오래 막는다. id를 미리 발급해
    // 트리 전체를 메모리에서 구성한 뒤 한 번에 bulk insert한다. id/created_at/
    // updated_at/version은 DB DEFAULT가 있으므로 자식 row에는 id만 직접 채운다.
    const blobIncrements = new Map<string, number>();
    const childRows: {
      id: string;
      namespaceId: string;
      parentId: string;
      type: VfsNodeType;
      name: string;
      blobId: string | null;
      size: string | null;
      mimeType: string | null;
    }[] = [];
    // BFS로 부모의 새 id가 먼저 정해진 뒤 자식의 parentId를 채운다. 실제 insert는
    // 한 트랜잭션 안에서 한 번에 일어나므로, 이 순서는 in-memory 구성 단계에서만
    // 필요하다.
    const queue: { oldParentId: string; newParentId: string }[] = [
      { oldParentId: sourceNode.id, newParentId: newRoot.id },
    ];

    while (queue.length > 0) {
      const { oldParentId, newParentId } = queue.shift() as { oldParentId: string; newParentId: string };

      for (const child of childrenByParent.get(oldParentId) ?? []) {
        const newId = randomUUID();

        if (child.type === 'FILE') {
          if (!child.blob_id) {
            throw new Error('FILE node에 blobId가 없음 — 데이터 일관성 위반');
          }
          if (child.size === null) throw new Error('FILE node에 size가 없음 — 데이터 일관성 위반');
          this.recordLiveByteDelta(tx, BigInt(child.size));
          blobIncrements.set(child.blob_id, (blobIncrements.get(child.blob_id) ?? 0) + 1);
        } else {
          queue.push({ oldParentId: child.id, newParentId: newId });
        }

        childRows.push({
          id: newId,
          namespaceId,
          parentId: newParentId,
          type: child.type,
          name: child.name,
          blobId: child.blob_id,
          size: child.size,
          mimeType: child.mime_type,
        });
      }
    }

    if (childRows.length > 0) {
      await nodeRepo.insert(nodeRepo.create(childRows));
      for (const child of childRows) this.markChanged(tx, child.id, false);
    }

    // moveNode/removeNode와 동일한 이유로, 여러 독립적인 Blob에 대한 증가를
    // 고정된 순서(blobId 오름차순)로 수행해 잠재적 AB-BA 교착 소지를 없앤다.
    const sortedBlobIncrements = [...blobIncrements].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [blobId, count] of sortedBlobIncrements) {
      await blobRepo.increment({ id: blobId }, 'referenceCount', count);
    }

    return { node: toRecord(newRoot), finalPath: joinSegments(finalSegments) };
  }
}
