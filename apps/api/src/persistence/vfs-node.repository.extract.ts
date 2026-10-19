// extract 결과 트리를 한 트랜잭션에서 destination에 반영한다. Blob object는 이미 storage에 있다.
// overwrite는 같은 경로 FILE의 node id를 유지하고 Blob만 바꾼다. clean은 destination subtree를 먼저 지운다.
// resource DTO는 withMutation의 version bump 뒤 readExtractResource로 읽는다. 규칙은 docs/design/17-file-extract.md "실행".
import { assertConditionalSegments } from '../vfs/path-resolver.js';
import type { ExtractMode } from '../vfs/dto/extract-request.dto.js';
import { toNodeResponse, type VfsNodeResponseDto } from '../vfs/dto/node-response.dto.js';
import { MAX_VFS_VERSION, decodeRevision } from '../vfs/revision.js';
import {
  VfsExtractTypeConflictError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsPreconditionFailedError,
  VfsRevisionExhaustedError,
} from '../vfs/vfs.errors.js';
import { BlobEntity } from './entities/blob.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { trackChangeFeedBefore } from './vfs-change-feed-journal.js';
import { VfsNodeRepositoryConditionals } from './vfs-node.repository.conditionals.js';
import { joinSegments, toRecord } from './vfs-node.repository.helpers.js';
import type { BlobData, MutationTx } from './vfs-node.repository.types.js';

/** 커밋할 entry 하나다. FILE은 Blob이 있고 DIRECTORY는 null이다. */
export interface ExtractCommitEntry {
  /** 오류 응답에 쓰는 선택 entry 순번이다. */
  readonly entryIndex: number;

  /** 오류 응답에 쓰는 archive 안의 원본 이름이다. */
  readonly name: string;

  /** destination 기준 상대 경로 segment다. */
  readonly segments: string[];

  readonly type: 'FILE' | 'DIRECTORY';

  readonly blob: BlobData | null;
}

/** applyExtract 입력이다. */
export interface ExtractCommitPlan {
  readonly destinationSegments: string[];

  /** 지정하면 커밋 시점의 대상 DIRECTORY가 일치해야 한다. */
  readonly destinationRevision?: string;

  readonly mode: ExtractMode;

  readonly entries: readonly ExtractCommitEntry[];

  /** clean 삭제가 허용하는 동기 삭제 node 수다. */
  readonly maxSyncDeleteNodes: number;
}

/** applyExtract 결과다. resource는 version bump 뒤 readExtractResource로 읽는다. */
export interface ExtractCommitResult {
  /** 커밋 직전 대상이 없었으면 201, 있었으면 200이다. clean으로 지우고 다시 만들어도 200이다. */
  readonly status: 200 | 201;

  readonly destinationId: string;

  /** 새로 만든 FILE 수다. DIRECTORY는 세지 않는다. */
  readonly createdCount: number;

  /** Blob을 교체한 기존 FILE 수다. */
  readonly replacedCount: number;

  /** clean이 기존 대상을 휴지통에 넣었을 때만 있다. */
  readonly trashId?: string;
}

export class VfsNodeRepositoryExtract extends VfsNodeRepositoryConditionals {
  /**
   * 압축 해제 결과를 destination 아래에 반영한다. 모든 오류는 호출한 트랜잭션을 롤백한다.
   *
   * 처리 순서:
   * 1. destination의 부모 사슬과 대상 종류·revision을 이 트랜잭션에서 다시 검사한다.
   * 2. clean이고 대상이 있으면 대상을 재귀 삭제한 뒤 다시 만든다. 대상이 없으면 만든다.
   * 3. entry를 순서대로 반영한다. 같은 경로 FILE은 id를 유지하고 Blob만 교체한다.
   *
   * status는 삭제 전 대상 존재 여부로 정한다. 종류 충돌은 entry 순번·이름·경로를 담은 409다.
   */
  @classifyPersistenceOperation
  async applyExtract(tx: MutationTx, plan: ExtractCommitPlan): Promise<ExtractCommitResult> {
    assertConditionalSegments(plan.destinationSegments);
    for (const entry of plan.entries) assertConditionalSegments(entry.segments);
    const { manager, namespaceId, rootId } = tx;
    const nodeRepo = manager.getRepository(VfsNodeEntity);
    const blobRepo = manager.getRepository(BlobEntity);
    const destinationPath = joinSegments(plan.destinationSegments);

    const parentId = await this.lockParentChain(
      manager,
      namespaceId,
      rootId,
      plan.destinationSegments,
      false,
      tx,
    );
    const existingDestination = await this.lockTargetNode(
      manager,
      namespaceId,
      parentId,
      plan.destinationSegments[plan.destinationSegments.length - 1],
      tx,
    );
    if (existingDestination && existingDestination.type !== 'DIRECTORY')
      throw new VfsNotDirectoryError(destinationPath);
    if (plan.destinationRevision !== undefined) {
      if (!existingDestination) throw new VfsNodeNotFoundError(destinationPath);
      const expected = decodeRevision(plan.destinationRevision);
      if (
        expected.id !== existingDestination.id.toLowerCase() ||
        expected.version !== existingDestination.version
      )
        throw new VfsPreconditionFailedError(
          destinationPath,
          this.currentOf(existingDestination, destinationPath),
        );
    }
    // status는 clean 삭제 전 존재 여부로 정한다. clean으로 새 id가 생겨도 200이다.
    const status: 200 | 201 = existingDestination ? 200 : 201;

    let trashId: string | null = null;
    let destinationId: string;
    if (plan.mode === 'clean' && existingDestination) {
      trashId = await this.removeNode(
        namespaceId,
        rootId,
        plan.destinationSegments,
        true,
        plan.maxSyncDeleteNodes,
        tx,
      );
      destinationId = (await this.ensureDirectory(namespaceId, rootId, plan.destinationSegments, false, tx))
        .node.id;
    } else if (existingDestination) {
      // 하위가 바뀌면 대상과 조상의 revision이 함께 올라가야 한다.
      await this.markAncestorChain(tx, existingDestination.id);
      destinationId = existingDestination.id;
    } else {
      destinationId = (await this.ensureDirectory(namespaceId, rootId, plan.destinationSegments, false, tx))
        .node.id;
    }

    // destination 기준 상대 경로('' = destination)에서 DIRECTORY node id로 가는 map이다.
    const directoryIds = new Map<string, string>([['', destinationId]]);
    const ensureRelativeDirectory = async (
      segments: readonly string[],
      entry: ExtractCommitEntry,
    ): Promise<string> => {
      let depth = segments.length;
      while (depth > 0 && !directoryIds.has(segments.slice(0, depth).join('/'))) depth -= 1;
      let parent = directoryIds.get(segments.slice(0, depth).join('/'))!;
      for (; depth < segments.length; depth += 1) {
        const name = segments[depth];
        const key = segments.slice(0, depth + 1).join('/');
        const existing = await this.lockTargetNode(manager, namespaceId, parent, name, tx);
        if (existing) {
          if (existing.type !== 'DIRECTORY')
            throw new VfsExtractTypeConflictError(entry.entryIndex, entry.name, `${destinationPath}/${key}`);
          directoryIds.set(key, existing.id);
          parent = existing.id;
          continue;
        }
        await trackChangeFeedBefore(tx, [parent]);
        const child = await nodeRepo.save(
          nodeRepo.create({ namespaceId, parentId: parent, type: 'DIRECTORY', name }),
        );
        this.recordLiveNodeDelta(tx, 1n);
        await this.markAncestorChain(tx, parent);
        this.markChanged(tx, child.id, false);
        directoryIds.set(key, child.id);
        parent = child.id;
      }
      return parent;
    };

    let createdCount = 0;
    let replacedCount = 0;
    for (const entry of plan.entries) {
      if (entry.type === 'DIRECTORY') {
        await ensureRelativeDirectory(entry.segments, entry);
        continue;
      }
      const blob = entry.blob;
      if (blob === null) throw new Error('FILE entry에 Blob이 없음');
      const fileParentId = await ensureRelativeDirectory(entry.segments.slice(0, -1), entry);
      const name = entry.segments[entry.segments.length - 1];
      const existing = await this.lockTargetNode(manager, namespaceId, fileParentId, name, tx);
      if (existing && existing.type !== 'FILE')
        throw new VfsExtractTypeConflictError(
          entry.entryIndex,
          entry.name,
          `${destinationPath}/${entry.segments.join('/')}`,
        );
      if (existing && existing.version >= MAX_VFS_VERSION) throw new VfsRevisionExhaustedError();

      const createdBlob = await blobRepo.save(blobRepo.create({ namespaceId, ...blob, referenceCount: 1 }));
      await this.markAncestorChain(tx, fileParentId);
      if (existing) {
        if (existing.blobId === null || existing.size === null)
          throw new Error('FILE node에 Blob 또는 size가 없음 — 데이터 일관성 위반');
        const previousBlobId = existing.blobId;
        const previousSize = BigInt(String(existing.size));
        // restoreBlob과 같은 규칙이다. version은 withMutation의 공통 bump가 한 번 올린다.
        await nodeRepo
          .createQueryBuilder()
          .update(VfsNodeEntity)
          .set({
            blobId: createdBlob.id,
            size: blob.size,
            mimeType: blob.mimeType,
            version: () => 'version',
          })
          .where('id = :id', { id: existing.id })
          .execute();
        this.markChanged(tx, existing.id, true);
        this.recordLiveByteDelta(tx, BigInt(blob.size) - previousSize);
        await this.blobRepository.decrementReferenceCount(manager, previousBlobId, 1);
        replacedCount += 1;
        continue;
      }
      const created = await nodeRepo.save(
        nodeRepo.create({
          namespaceId,
          parentId: fileParentId,
          name,
          type: 'FILE',
          blobId: createdBlob.id,
          size: blob.size,
          mimeType: blob.mimeType,
        }),
      );
      this.markChanged(tx, created.id, false);
      this.recordLiveByteDelta(tx, BigInt(blob.size));
      this.recordFolderFileDelta(tx, fileParentId, 1n);
      this.recordLiveNodeDelta(tx, 1n);
      createdCount += 1;
    }

    return {
      status,
      destinationId,
      createdCount,
      replacedCount,
      ...(trashId ? { trashId } : {}),
    };
  }

  /**
   * withMutation의 afterBump에서 최종 destination DTO를 읽는다.
   * version bump 뒤 같은 트랜잭션에서 읽으므로 `version`·`updatedAt`은 커밋될 상태다.
   */
  @classifyPersistenceOperation
  async readExtractResource(
    tx: MutationTx,
    destinationId: string,
    destinationSegments: string[],
  ): Promise<VfsNodeResponseDto> {
    const node = await tx.manager
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ id: destinationId, namespaceId: tx.namespaceId });
    return toNodeResponse(toRecord(node), joinSegments(destinationSegments));
  }
}
