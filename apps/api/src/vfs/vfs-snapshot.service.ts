import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DomainError } from '../common/domain-error.js';
import { isUuid } from '../common/uuid.js';
import { getEncrypted } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import {
  VfsNodeRepository,
  type MutationTx,
  type AffectedRevision,
} from '../persistence/vfs-node.repository.js';
import {
  VfsSnapshotRepository,
  resolveSnapshotLimits,
  type SnapshotMetadata as StoredSnapshot,
} from '../persistence/vfs-snapshot.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import type { ContentPayload } from './content.service.js';
import { toNodeResponse, toPreconditionCurrent } from './dto/node-response.dto.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { parseSnapshotCreateRequest, parseSnapshotRestoreRequest } from './dto/snapshot-request.dto.js';
import {
  busyResponse,
  replayReceipt,
  storeErrorReceipt,
  type ErrorReceiptOwner,
} from './mutation-receipt.js';
import { hashParts, identityOf, type MutationHttpResult } from './mutation.service.js';
import { decodeSnapshotCursor, encodeSnapshotCursor } from './snapshot-cursor.js';
import { resolveLimit } from './pagination.js';
import { parseRange } from './range.js';
import { requireRoot } from './require-root.js';
import {
  resolveSnapshotSourcePath,
  resolveSnapshotRestorePath,
  resolveSnapshotRelativePath,
} from './snapshot-path.js';
import {
  VfsInvalidMutationRequestError,
  VfsInvalidOperationError,
  VfsIsDirectoryError,
  VfsNamespaceNotFoundError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsPreconditionFailedError,
} from './vfs.errors.js';

export interface SnapshotMetadata {
  readonly snapshotId: string;
  readonly kind: 'file' | 'tree';
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly rootNodeId: string;
  readonly rootType: 'FILE' | 'DIRECTORY';
  readonly nodeCount: number;
  readonly logicalBytes: string;
  readonly createdAt: string;
}

export interface SnapshotEntryPage {
  readonly items: Array<{
    readonly relativePath: string;
    readonly type: 'FILE' | 'DIRECTORY';
    readonly sourceNodeId: string;
    readonly sourceRevision: string;
    readonly size: string | null;
    readonly mimeType: string | null;
    readonly contentPath: string | null;
  }>;
  readonly nextCursor: string | null;
}

function toMetadata(snapshot: StoredSnapshot): SnapshotMetadata {
  return {
    snapshotId: snapshot.id,
    kind: snapshot.kind === 'FILE' ? 'file' : 'tree',
    sourcePath: snapshot.sourcePath,
    sourceRevision: snapshot.sourceRevision,
    rootNodeId: snapshot.rootNodeId,
    rootType: snapshot.rootType,
    nodeCount: snapshot.nodeCount,
    logicalBytes: String(snapshot.logicalBytes),
    createdAt: snapshot.createdAt.toISOString(),
  };
}

function canonicalSnapshotId(id: string): string {
  if (!isUuid(id)) throw new VfsNodeNotFoundError(id);
  return id.toLowerCase();
}

@Injectable()
export class VfsSnapshotService {
  constructor(
    private readonly nodes: VfsNodeRepository,
    private readonly snapshots: VfsSnapshotRepository,
    private readonly receipts: VfsMutationReceiptRepository,
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
  ) {}

  async create(
    namespaceId: string,
    scope: string | undefined,
    key: string | undefined,
    rawBody: Buffer | undefined,
    requestId: string,
  ): Promise<MutationHttpResult> {
    return this.executeJson(
      namespaceId,
      scope,
      key,
      'snapshots',
      rawBody,
      requestId,
      parseSnapshotCreateRequest,
      async (tx, command) => {
        const namespace = await tx.manager.findOneBy(NamespaceEntity, { id: namespaceId });
        if (!namespace) throw new VfsNamespaceNotFoundError(namespaceId);
        const { segments } = resolveSnapshotSourcePath(command.path, command.kind);
        const rows = await this.nodes.captureSnapshotRows(
          tx,
          segments,
          resolveSnapshotLimits(namespace).maxNodes,
        );
        if (command.kind === 'file' && rows[0]?.type === 'DIRECTORY')
          throw new VfsIsDirectoryError(command.path);
        if (command.kind === 'tree' && rows[0]?.type !== 'DIRECTORY')
          throw new VfsNotDirectoryError(command.path);
        // 예산 UPDATE·Blob ref 증가(capture) 전에 root 잠금 아래에서 비교한다.
        // 불일치면 어떤 snapshot/manifest/ref/usage 행도 만들지 않는다.
        if (command.sourceRevision !== undefined && rows[0].revision !== command.sourceRevision) {
          const source = await tx.manager.findOneBy(VfsNodeEntity, { id: rows[0].id, namespaceId });
          throw new VfsPreconditionFailedError(
            command.path,
            source ? toPreconditionCurrent(source, command.path) : null,
          );
        }
        const snapshot = await this.snapshots.capture(tx, {
          kind: command.kind === 'file' ? 'FILE' : 'TREE',
          sourcePath: command.path,
          rows,
        });
        return { status: 201, body: toMetadata(snapshot), headers: { 'x-request-id': requestId } };
      },
    );
  }

  async get(namespaceId: string, snapshotId: string): Promise<SnapshotMetadata> {
    await requireRoot(this.nodes, namespaceId);
    const snapshot = await this.snapshots.get(namespaceId, canonicalSnapshotId(snapshotId));
    if (!snapshot) throw new VfsNodeNotFoundError(snapshotId);
    return toMetadata(snapshot);
  }

  async listEntries(
    namespaceId: string,
    snapshotId: string,
    cursor: string | undefined,
    limit: string | undefined,
  ): Promise<SnapshotEntryPage> {
    await requireRoot(this.nodes, namespaceId);
    const id = canonicalSnapshotId(snapshotId);
    const snapshot = await this.snapshots.get(namespaceId, id);
    if (!snapshot) throw new VfsNodeNotFoundError(id);
    if (snapshot.kind !== 'TREE') throw new VfsInvalidOperationError(id);
    const after = cursor === undefined ? null : decodeSnapshotCursor(cursor, id).pathKey;
    const page = await this.snapshots.listEntries(namespaceId, id, after, resolveLimit(limit));
    // 삭제는 전체 manifest를 원자적으로 없앤다. 두 조회 사이 삭제됐다면
    // 존재할 수 없는 빈 TREE manifest를 성공 응답으로 반환하지 않는다.
    if (page.entries.length === 0 && !(await this.snapshots.get(namespaceId, id))) {
      throw new VfsNodeNotFoundError(id);
    }
    return {
      items: page.entries.map((entry) => ({
        relativePath: entry.relativePath,
        type: entry.type,
        sourceNodeId: entry.sourceNodeId,
        sourceRevision: entry.sourceRevision,
        size: entry.size === null ? null : String(entry.size),
        mimeType: entry.mimeType,
        contentPath:
          entry.type === 'FILE'
            ? `/api/v1/namespaces/${namespaceId}/fs/snapshots/${id}/content?path=${encodeURIComponent(entry.relativePath)}`
            : null,
      })),
      nextCursor:
        page.nextPathKey === null
          ? null
          : encodeSnapshotCursor({ snapshotId: id, pathKey: page.nextPathKey }),
    };
  }

  async getContent(
    namespaceId: string,
    snapshotId: string,
    relativePath: string | undefined,
    rangeHeader: string | undefined,
  ): Promise<ContentPayload> {
    const root = await requireRoot(this.nodes, namespaceId);
    const id = canonicalSnapshotId(snapshotId);
    const opened: { stream?: Readable; error?: Error } = {};
    try {
      const result = await this.nodes.withMutation(namespaceId, root.id, async (tx) => {
        const snapshot = await this.snapshots.findForUpdate(tx, namespaceId, id);
        if (!snapshot) throw new VfsNodeNotFoundError(id);
        if (
          (snapshot.kind === 'FILE' && relativePath !== undefined) ||
          (snapshot.kind === 'TREE' && relativePath === undefined)
        )
          throw new VfsInvalidMutationRequestError();
        const path = snapshot.kind === 'FILE' ? '.' : resolveSnapshotRelativePath(relativePath!).canonical;
        const entry =
          snapshot.kind === 'FILE'
            ? await this.snapshots.getFileEntry(tx, id)
            : await this.snapshots.getEntry(tx, id, path);
        if (!entry) throw new VfsNodeNotFoundError(path);
        if (entry.type === 'DIRECTORY') throw new VfsIsDirectoryError(path);
        if (!entry.blobId) throw new VfsNodeNotFoundError(path);
        const blob = await tx.manager.findOneBy(BlobEntity, { id: entry.blobId, namespaceId });
        const namespace = await tx.manager.findOneBy(NamespaceEntity, { id: namespaceId });
        if (!blob || !namespace) throw new VfsNodeNotFoundError(id);
        const totalSize = Number(entry.size);
        const range = rangeHeader ? parseRange(rangeHeader, totalSize) : undefined;
        const stream =
          namespace.encryptionPolicy === 'ENCRYPTED'
            ? await getEncrypted(
                this.storage,
                blob.storageKey,
                blob.encryptionIv as Buffer,
                this.requireMasterKey(),
                range,
              )
            : await this.storage.get(blob.storageKey, range);
        opened.stream = stream;
        // DB commit 및 HTTP pipeline 연결 전에도 stream 오류가 소유자 없이 발생하지 않게 한다.
        const onError = (error: Error) => {
          opened.error ??= error;
          stream.destroy(error);
        };
        stream.on('error', onError);
        // HTTP handoff 뒤에도 close까지 유지하여 listener 교체 사이의 오류 유실을 막는다.
        stream.once('close', () => stream.off('error', onError));
        if (stream.errored) opened.error ??= stream.errored;
        return {
          name: (snapshot.kind === 'FILE' ? snapshot.sourcePath : path).split('/').at(-1) ?? '',
          mimeType: entry.mimeType ?? 'application/octet-stream',
          status: range ? 206 : 200,
          contentLength: range ? range.end - range.start + 1 : totalSize,
          ...(range ? { contentRange: `bytes ${range.start}-${range.end}/${totalSize}` } : {}),
          stream,
        };
      });
      if (opened.error) throw opened.error;
      return result.value;
    } catch (error) {
      opened.stream?.destroy();
      throw error;
    }
  }

  async restore(
    namespaceId: string,
    snapshotId: string,
    scope: string | undefined,
    key: string | undefined,
    rawBody: Buffer | undefined,
    requestId: string,
  ): Promise<MutationHttpResult> {
    const id = canonicalSnapshotId(snapshotId);
    let restoredNodeId: string | undefined;
    let restoredPath: string | undefined;
    return this.executeJson(
      namespaceId,
      scope,
      key,
      `snapshots/${id}/restore`,
      rawBody,
      requestId,
      parseSnapshotRestoreRequest,
      async (tx, command) => {
        // withMutation이 root를 잠근 뒤 snapshot을 먼저 확인한다. target은 그 다음이다.
        const snapshot = await this.snapshots.findForUpdate(tx, namespaceId, id);
        if (!snapshot || snapshot.kind !== 'FILE') throw new VfsNodeNotFoundError(id);
        const entry = await this.snapshots.getFileEntry(tx, id);
        if (!entry?.blobId || entry.size === null || entry.mimeType === null)
          throw new VfsNodeNotFoundError(id);
        const outcome = await this.nodes.restoreBlob(
          tx,
          resolveSnapshotRestorePath(command.path).segments,
          command.condition,
          {
            blobId: entry.blobId,
            size: entry.size,
            mimeType: entry.mimeType,
          },
        );
        restoredNodeId = outcome.node.id;
        restoredPath = command.path;
        return {
          status: outcome.kind === 'created' ? 201 : 200,
          body: null,
          headers: { 'x-request-id': requestId },
        };
      },
      async (tx, result, affectedRevisions) => {
        if (!restoredNodeId || !restoredPath) return result;
        const node = await tx.manager.findOneByOrFail(VfsNodeEntity, { id: restoredNodeId, namespaceId });
        return {
          ...result,
          body: { snapshotId: id, resource: toNodeResponse(node, restoredPath), affectedRevisions },
        };
      },
    );
  }

  async delete(
    namespaceId: string,
    snapshotId: string,
    scope: string | undefined,
    key: string | undefined,
    rawBody: Buffer | undefined,
    requestId: string,
  ): Promise<MutationHttpResult> {
    const id = canonicalSnapshotId(snapshotId);
    return this.executeJson(
      namespaceId,
      scope,
      key,
      `snapshots/${id}/delete`,
      rawBody,
      requestId,
      (body) => {
        if (
          body === null ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 0
        )
          throw new VfsInvalidMutationRequestError();
        return {};
      },
      async (tx) => {
        const snapshot = await this.snapshots.findForUpdate(tx, namespaceId, id);
        if (!snapshot) throw new VfsNodeNotFoundError(id);
        await this.snapshots.remove(tx, snapshot);
        return {
          status: 200,
          body: { snapshotId: id, deleted: true },
          headers: { 'x-request-id': requestId },
        };
      },
    );
  }

  // 정규화 command와 원본 bytes를 함께 식별하므로 JSON 공백 변경도 key 재사용 충돌이다.
  private async executeJson<T>(
    namespaceId: string,
    scope: string | undefined,
    key: string | undefined,
    route: string,
    rawBody: Buffer | undefined,
    requestId: string,
    parse: (body: unknown) => T,
    work: (tx: MutationTx, command: T) => Promise<MutationHttpResult>,
    finalize?: (
      tx: MutationTx,
      result: MutationHttpResult,
      revisions: AffectedRevision[],
    ) => Promise<MutationHttpResult>,
  ): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const root = await requireRoot(this.nodes, namespaceId);
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
    let command: T | null = null;
    let parseError: DomainError | null = null;
    try {
      command = parse(JSON.parse(bytes.toString('utf8')) as unknown);
    } catch (error) {
      parseError = error instanceof DomainError ? error : new VfsInvalidMutationRequestError();
    }
    const fingerprint = hashParts([
      'POST',
      route,
      JSON.stringify(command ?? 'invalid'),
      createHash('sha256').update(bytes).digest('hex'),
    ]);
    const claim = await this.receipts.claim(identity, new Date());
    if (claim.kind === 'busy') return busyResponse(claim.retryAfterSeconds, requestId);
    if (claim.kind === 'complete') return replayReceipt(claim.receipt, 'POST', fingerprint, requestId);
    const owner: ErrorReceiptOwner = {
      identity,
      generation: claim.generation,
      fingerprint,
      method: 'POST',
      requestBodyBytes: bytes.length,
    };
    try {
      if (parseError) return await storeErrorReceipt(this.receipts, owner, parseError, requestId);
      let response: MutationHttpResult | undefined;
      try {
        await this.nodes.withMutation(
          namespaceId,
          root.id,
          (tx) => work(tx, command as T),
          async (tx, applied) => {
            response = finalize
              ? await finalize(tx, applied.value, applied.affectedRevisions)
              : applied.value;
            await this.receipts.complete(
              tx,
              identity,
              claim.generation,
              fingerprint,
              'POST',
              response,
              bytes.length,
            );
          },
        );
      } catch (error) {
        // work·finalize·성공 receipt 완료 중 하나가 실패해 트랜잭션이 롤백됐다.
        return await storeErrorReceipt(this.receipts, owner, error, requestId);
      }
      return response!;
    } catch (error) {
      await this.receipts.release(identity, claim.generation);
      throw error;
    }
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) throw new Error('ENCRYPTED namespace master key missing');
    return this.masterKey;
  }
}
