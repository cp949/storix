import { classifyPersistenceOperation } from './persistence-failure.js';
import { parsePositiveInt } from '../common/env-parsing.js';
import { resolveEffectiveLimit } from '../common/resource-limit.js';
import { MAX_VFS_VERSION, decodeRevision } from '../vfs/revision.js';
import type { ConditionalMutation } from '../vfs/dto/conditional-mutation-request.dto.js';
import { assertConditionalSegments } from '../vfs/path-resolver.js';
import {
  toConditionalContentResponse,
  toNodeResponse,
  VfsConditionalContentResourceDto,
  VfsNodeResponseDto,
} from '../vfs/dto/node-response.dto.js';
import {
  VfsAlreadyExistsError,
  VfsInvalidOperationError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsPreconditionFailedError,
  VfsRevisionExhaustedError,
} from '../vfs/vfs.errors.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import type {
  BlobData,
  RestorableBlob,
  PutFileOutcome,
  MutationTx,
  ContentPrecondition,
} from './vfs-node.repository.types.js';
import { toRecord, joinSegments } from './vfs-node.repository.helpers.js';
import { VfsNodeRepositoryTreeMutations } from './vfs-node.repository.tree-mutations.js';

export class VfsNodeRepositoryConditionals extends VfsNodeRepositoryTreeMutations {
  private assertRevision(node: VfsNodeEntity, revision: string, path: string): void {
    const expected = decodeRevision(revision);
    if (node.id !== expected.id || node.version !== expected.version) {
      throw new VfsPreconditionFailedError(path, this.currentOf(node, path));
    }
  }

  @classifyPersistenceOperation
  async applyConditionalMutation(
    tx: MutationTx,
    command: ConditionalMutation,
  ): Promise<{ status: 200 | 201; resource: VfsNodeResponseDto | null }> {
    if (command.kind === 'mkdir' || command.kind === 'delete') {
      assertConditionalSegments(command.segments);
    } else {
      assertConditionalSegments(command.sourceSegments);
      assertConditionalSegments(command.destinationSegments);
    }
    const namespaceId = tx.namespaceId;
    const rootId = tx.rootId;
    if (command.kind === 'mkdir') {
      const existing = await this.resolvePathInManager(tx.manager, namespaceId, rootId, command.segments);
      if (existing) {
        throw new VfsPreconditionFailedError(command.path, this.currentOf(existing, command.path));
      }
      const result = await this.ensureDirectory(namespaceId, rootId, command.segments, false, tx);
      return { status: 201, resource: toNodeResponse(result.node, command.path) };
    }

    const namespace = await tx.manager.getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
    if (command.kind === 'delete') {
      const target = await this.resolvePathInManager(tx.manager, namespaceId, rootId, command.segments);
      if (!target) throw new VfsNodeNotFoundError(command.path);
      this.assertRevision(target, command.ifRevision, command.path);
      const max = resolveEffectiveLimit(
        namespace.maxSyncDeleteNodes,
        parsePositiveInt(process.env.STORIX_MAX_SYNC_DELETE_NODES, 1000),
      );
      if (target.type === 'DIRECTORY' && !command.recursive) {
        await this.removeEmptyDirectory(namespaceId, rootId, command.segments, tx);
      } else {
        await this.removeNode(namespaceId, rootId, command.segments, command.recursive, max, tx);
      }
      return { status: 200, resource: null };
    }

    const source = await this.resolvePathInManager(tx.manager, namespaceId, rootId, command.sourceSegments);
    if (!source) throw new VfsNodeNotFoundError(command.source);
    this.assertRevision(source, command.sourceRevision, command.source);
    try {
      if (command.kind === 'move') {
        const result = await this.moveNode(
          namespaceId,
          rootId,
          command.sourceSegments,
          command.destinationSegments,
          false,
          tx,
          command.destinationResolution,
        );
        return { status: 200, resource: toNodeResponse(result.node, result.finalPath) };
      }
      const max = resolveEffectiveLimit(
        namespace.maxSyncCopyNodes,
        parsePositiveInt(process.env.STORIX_MAX_SYNC_COPY_NODES, 1000),
      );
      const result = await this.copyNode(
        namespaceId,
        rootId,
        command.sourceSegments,
        command.destinationSegments,
        false,
        max,
        tx,
        command.destinationResolution,
      );
      return { status: 201, resource: toNodeResponse(result.node, result.finalPath) };
    } catch (error) {
      if (error instanceof VfsAlreadyExistsError) {
        // 충돌한 목적지 노드를 같은 트랜잭션에서 다시 읽는다(경로는 정규화된 세그먼트 조합이다).
        const collision = await this.resolvePathInManager(
          tx.manager,
          namespaceId,
          rootId,
          error.path.split('/').filter((segment) => segment.length > 0),
        );
        throw new VfsPreconditionFailedError(error.path, this.currentOf(collision, error.path));
      }
      throw error;
    }
  }

  @classifyPersistenceOperation
  async putConditionalContent(
    tx: MutationTx,
    segments: string[],
    condition: ContentPrecondition,
    blob: BlobData,
  ): Promise<{ status: 200 | 201; resource: VfsConditionalContentResourceDto }> {
    assertConditionalSegments(segments);
    const path = joinSegments(segments);
    const existing = await this.resolvePathInManager(tx.manager, tx.namespaceId, tx.rootId, segments);
    if ('ifAbsent' in condition) {
      if (existing) throw new VfsPreconditionFailedError(path, this.currentOf(existing, path));
    } else {
      if (!existing) throw new VfsNodeNotFoundError(path);
      this.assertRevision(existing, condition.ifRevision, path);
    }
    const outcome = await this.putFileContent(
      tx.namespaceId,
      tx.rootId,
      segments,
      false,
      blob,
      existing?.version ?? null,
      false,
      tx,
    );
    return {
      status: outcome.kind === 'created' ? 201 : 200,
      resource: toConditionalContentResponse(outcome.node, path),
    };
  }

  @classifyPersistenceOperation
  async restoreBlob(
    tx: MutationTx,
    segments: string[],
    condition: ContentPrecondition,
    blob: RestorableBlob,
  ): Promise<PutFileOutcome> {
    const path = joinSegments(segments);
    const parentId = await this.lockParentChain(tx.manager, tx.namespaceId, tx.rootId, segments, false, tx);
    const name = segments[segments.length - 1];
    const existing = await this.lockTargetNode(tx.manager, tx.namespaceId, parentId, name, tx);
    if (existing?.type === 'DIRECTORY') throw new VfsIsDirectoryError(path);
    if ('ifAbsent' in condition) {
      if (existing) throw new VfsPreconditionFailedError(path, this.currentOf(existing, path));
    } else {
      if (!existing) throw new VfsNodeNotFoundError(path);
      this.assertRevision(existing, condition.ifRevision, path);
    }
    if (existing && existing.version >= MAX_VFS_VERSION) throw new VfsRevisionExhaustedError();
    if (existing?.blobId !== blob.blobId) {
      if (
        !(await this.blobRepository.incrementLiveReferenceCount(tx.manager, tx.namespaceId, blob.blobId, 1))
      )
        throw new VfsInvalidOperationError(path);
      if (existing?.blobId) await this.blobRepository.decrementReferenceCount(tx.manager, existing.blobId, 1);
    }
    const nodeRepo = tx.manager.getRepository(VfsNodeEntity);
    if (existing) {
      // 같은 Blob을 복원해도 현재 파일 mutation이므로 revision을 정확히 한 번 올린다.
      // save()의 자동 version 갱신 대신 withMutation의 공통 bump에 맡긴다.
      await nodeRepo
        .createQueryBuilder()
        .update(VfsNodeEntity)
        .set({
          blobId: blob.blobId,
          size: blob.size,
          mimeType: blob.mimeType,
          version: () => 'version',
        })
        .where('id = :id', { id: existing.id })
        .execute();
      this.markChanged(tx, existing.id, true);
      this.recordLiveByteDelta(tx, BigInt(blob.size) - BigInt(String(existing.size)));
      return { kind: 'replaced', node: toRecord({ ...existing, ...blob }) };
    }
    const created = await nodeRepo.save(
      nodeRepo.create({
        namespaceId: tx.namespaceId,
        parentId,
        name,
        type: 'FILE',
        blobId: blob.blobId,
        size: blob.size,
        mimeType: blob.mimeType,
      }),
    );
    this.markChanged(tx, created.id, false);
    this.recordLiveByteDelta(tx, BigInt(blob.size));
    return { kind: 'created', node: toRecord(created) };
  }
}
