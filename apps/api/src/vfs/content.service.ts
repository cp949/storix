import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { parsePositiveInt } from '../common/env-parsing.js';
import { buildContentDisposition } from './content-disposition.js';
import { getEncrypted } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { EncryptionPolicy } from '../persistence/entities/namespace.entity.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import {
  NamespaceResourceLimits,
  VfsContentBlobRef,
  VfsNodeRecord,
  VfsNodeRepository,
} from '../persistence/vfs-node.repository.js';
import { toNodeResponse, VfsNodeResponseDto } from './dto/node-response.dto.js';
import { normalizeMimeType } from './mime.js';
import { PathResolver } from './path-resolver.js';
import { parseRange } from './range.js';
import { resolveFileSizeLimits, resolveMaxFileSizeBytes } from '../common/resource-limit.js';
import { requireRootWithLimits } from './require-root.js';
import { encodeRevision } from './revision.js';
import {
  VfsIsDirectoryError,
  VfsNamespaceNotFoundError,
  VfsNodeNotFoundError,
  VfsPresignedEncryptedUnsupportedError,
} from './vfs.errors.js';
import { ContentIngressService } from './content-ingress.service.js';

const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export interface PutContentOptions {
  readonly contentType: string | undefined;
  readonly contentLength: string | undefined;
  readonly ifMatch: string | undefined;
  readonly force: boolean;
  readonly parents: boolean;
}

// HEAD 응답에 필요한 헤더 정보다. Blob을 열지 않고 만든다.
export interface ContentHeadPayload {
  readonly name: string;
  readonly mimeType: string;
  readonly status: number;
  readonly contentLength: number;
  readonly contentRange?: string;
  readonly identity?: { readonly fileId: string; readonly revision: string; readonly sha256: string };
  readonly partialIdentity?: {
    readonly fileId: string;
    readonly revision: string;
    readonly snapshotId?: string;
  };
}

export interface ContentPayload extends ContentHeadPayload {
  readonly stream: Readable;
}

export interface PresignedDownloadPayload {
  readonly url: string;
  readonly expiresAt: string;
}

function parseIfMatch(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim().replace(/^"|"$/g, '');
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

@Injectable()
export class ContentService {
  private readonly maxFileSizeBytes: number;
  private readonly defaultMaxFileSizeBytes: number;
  private readonly presignedUrlExpirySeconds: number;

  constructor(
    private readonly pathResolver: PathResolver,
    private readonly repo: VfsNodeRepository,
    private readonly keyGenerator: StorageKeyGenerator,
    @Inject(BLOB_STORAGE) private readonly blobStorage: BlobStorage,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
    private readonly contentIngress: ContentIngressService,
    config: ConfigService,
  ) {
    const fileSizeLimits = resolveFileSizeLimits(
      config.get<string>('STORIX_DEFAULT_FILE_SIZE_BYTES'),
      config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'),
    );
    this.maxFileSizeBytes = fileSizeLimits.ceilingBytes;
    this.defaultMaxFileSizeBytes = fileSizeLimits.defaultBytes;
    this.presignedUrlExpirySeconds = parsePositiveInt(
      config.get<string>('STORIX_PRESIGNED_URL_EXPIRY_SECONDS'),
      300,
    );
    if (this.presignedUrlExpirySeconds > 604800) {
      throw new Error(
        `STORIX_PRESIGNED_URL_EXPIRY_SECONDS는 604800(7일)을 초과할 수 없음: ${this.presignedUrlExpirySeconds}`,
      );
    }
  }

  async touch(
    namespaceId: string,
    rawPath: string,
    parents: boolean,
  ): Promise<{ status: number; body: VfsNodeResponseDto }> {
    const { root, limits } = await requireRootWithLimits(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);

    if (segments.length === 0) {
      throw new VfsIsDirectoryError(canonical);
    }

    const storageKey = this.keyGenerator.generate();
    const encryptionIv = await this.putBlobBytes(
      storageKey,
      Readable.from(Buffer.alloc(0)),
      'application/octet-stream',
      limits.encryptionPolicy,
    );

    const outcome = await this.repo.touchFile(namespaceId, root.id, segments, parents, {
      storageKey,
      size: '0',
      mimeType: 'application/octet-stream',
      sha256: EMPTY_SHA256,
      encryptionIv,
    });

    return {
      status: outcome.kind === 'created' ? 201 : 200,
      body: toNodeResponse(outcome.node, canonical),
    };
  }

  async putContent(
    namespaceId: string,
    rawPath: string,
    source: Readable,
    options: PutContentOptions,
  ): Promise<{ status: number; body: VfsNodeResponseDto }> {
    const { root, limits } = await requireRootWithLimits(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);

    if (segments.length === 0) {
      throw new VfsIsDirectoryError(canonical);
    }

    const existingTarget = await this.repo.resolvePath(namespaceId, root.id, segments);
    if (existingTarget?.type === 'DIRECTORY') {
      throw new VfsIsDirectoryError(canonical);
    }

    const maxFileSizeBytes = resolveMaxFileSizeBytes(
      limits.maxFileSizeBytes,
      this.maxFileSizeBytes,
      this.defaultMaxFileSizeBytes,
    );

    const contentLength = options.contentLength !== undefined ? Number(options.contentLength) : undefined;
    if (contentLength !== undefined && contentLength > maxFileSizeBytes) {
      throw new VfsFileTooLargeError(maxFileSizeBytes);
    }

    const mimeType = normalizeMimeType(options.contentType);
    const storageKey = this.keyGenerator.generate();
    const uploaded = await this.contentIngress.upload(
      storageKey,
      source,
      mimeType,
      maxFileSizeBytes,
      limits.encryptionPolicy === 'ENCRYPTED',
    );

    const outcome = await this.repo.putFileContent(
      namespaceId,
      root.id,
      segments,
      options.parents,
      {
        storageKey,
        size: String(uploaded.size),
        mimeType,
        sha256: uploaded.sha256,
        encryptionIv: uploaded.encryptionIv,
      },
      parseIfMatch(options.ifMatch),
      options.force,
    );

    return {
      status: outcome.kind === 'created' ? 201 : 200,
      body: toNodeResponse(outcome.node, canonical),
    };
  }

  // headOnly면 Blob을 열지 않고 헤더 정보만 반환한다(HEAD 요청).
  async getContent(
    namespaceId: string,
    rawPath: string,
    rangeHeader: string | undefined,
  ): Promise<ContentPayload>;
  async getContent(
    namespaceId: string,
    rawPath: string,
    rangeHeader: string | undefined,
    headOnly: boolean,
  ): Promise<ContentPayload | ContentHeadPayload>;
  async getContent(
    namespaceId: string,
    rawPath: string,
    rangeHeader: string | undefined,
    headOnly = false,
  ): Promise<ContentPayload | ContentHeadPayload> {
    const { root, limits } = await requireRootWithLimits(this.repo, namespaceId);
    return this.readContent(namespaceId, root, limits, rawPath, rangeHeader, true, headOnly);
  }

  async getPublicContent(
    namespaceId: string,
    rawPath: string,
    rangeHeader: string | undefined,
  ): Promise<ContentPayload>;
  async getPublicContent(
    namespaceId: string,
    rawPath: string,
    rangeHeader: string | undefined,
    headOnly: boolean,
  ): Promise<ContentPayload | ContentHeadPayload>;
  async getPublicContent(
    namespaceId: string,
    rawPath: string,
    rangeHeader: string | undefined,
    headOnly = false,
  ): Promise<ContentPayload | ContentHeadPayload> {
    const { root, limits } = await requireRootWithLimits(this.repo, namespaceId);

    // 공개 표면에는 제시할 자격증명 개념이 없다. 401/403은 "존재하지만 비공개"를
    // 알려주는 오라클이 되므로 미존재와 동일한 404로 응답한다.
    if (limits.accessPolicy !== 'PUBLIC') {
      throw new VfsNamespaceNotFoundError(namespaceId);
    }

    // 생성 시 조합이 차단되어 정상 경로에서는 도달하지 않는다. 데이터가 어떤
    // 경로로든 이 상태가 되어도 복호화 결과가 무인증으로 나가지 않게 막는다.
    if (limits.encryptionPolicy === 'ENCRYPTED') {
      throw new VfsNamespaceNotFoundError(namespaceId);
    }

    return this.readContent(namespaceId, root, limits, rawPath, rangeHeader, false, headOnly);
  }

  private async readContent(
    namespaceId: string,
    root: VfsNodeRecord,
    limits: NamespaceResourceLimits,
    rawPath: string,
    rangeHeader: string | undefined,
    authenticated: boolean,
    headOnly: boolean,
  ): Promise<ContentPayload | ContentHeadPayload> {
    const { canonical, segments } = this.pathResolver.resolve(rawPath);
    const read = await this.repo.readContentFile(namespaceId, root.id, segments);
    const target = read?.node;

    if (!target) {
      throw new VfsNodeNotFoundError(canonical);
    }
    // 확정되지 않은 파일은 공개 표면에서 없는 파일과 같은 404로 숨긴다.
    if (!authenticated && target.expiresAt !== null) {
      throw new VfsNodeNotFoundError(canonical);
    }
    if (target.type === 'DIRECTORY') {
      throw new VfsIsDirectoryError(canonical);
    }

    const { storageKey, encryptionIv, sha256 } = read.blob as VfsContentBlobRef;
    const totalSize = Number(target.size);
    const mimeType = target.mimeType ?? 'application/octet-stream';

    if (!rangeHeader) {
      const head: ContentHeadPayload = {
        name: target.name,
        mimeType,
        status: 200,
        contentLength: totalSize,
        ...(authenticated
          ? { identity: { fileId: target.id, revision: encodeRevision(target), sha256 } }
          : {}),
      };
      // HEAD는 본문을 보내지 않으므로 Blob 읽기와 복호화를 건너뛴다.
      if (headOnly) return head;
      const stream =
        limits.encryptionPolicy === 'ENCRYPTED'
          ? await getEncrypted(this.blobStorage, storageKey, encryptionIv as Buffer, this.requireMasterKey())
          : await this.blobStorage.get(storageKey);
      return { ...head, stream };
    }

    const range = parseRange(rangeHeader, totalSize);
    const head: ContentHeadPayload = {
      name: target.name,
      mimeType,
      status: 206,
      contentRange: `bytes ${range.start}-${range.end}/${totalSize}`,
      contentLength: range.end - range.start + 1,
      partialIdentity: { fileId: target.id, revision: encodeRevision(target) },
    };
    if (headOnly) return head;
    const stream =
      limits.encryptionPolicy === 'ENCRYPTED'
        ? await getEncrypted(
            this.blobStorage,
            storageKey,
            encryptionIv as Buffer,
            this.requireMasterKey(),
            range,
          )
        : await this.blobStorage.get(storageKey, range);

    return { ...head, stream };
  }

  async getPresignedDownloadUrl(namespaceId: string, rawPath: string): Promise<PresignedDownloadPayload> {
    const { root, limits } = await requireRootWithLimits(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);
    const target = segments.length === 0 ? root : await this.repo.resolvePath(namespaceId, root.id, segments);

    if (!target) {
      throw new VfsNodeNotFoundError(canonical);
    }
    if (target.type === 'DIRECTORY') {
      throw new VfsIsDirectoryError(canonical);
    }
    if (limits.encryptionPolicy === 'ENCRYPTED') {
      throw new VfsPresignedEncryptedUnsupportedError(canonical);
    }

    const blobInfo = await this.repo.getBlobStorageInfo(namespaceId, target.blobId as string);
    const { storageKey } = blobInfo as { storageKey: string; encryptionIv: Buffer | null };

    const issuedAt = Date.now();
    const url = await this.blobStorage.getPresignedUrl(
      storageKey,
      this.presignedUrlExpirySeconds,
      buildContentDisposition(target.name),
      // Blob은 COW로 공유되어 객체 메타데이터를 노드별로 바꿀 수 없으므로 노드 MIME을 응답 헤더로 재정의한다.
      target.mimeType ?? 'application/octet-stream',
    );
    const expiresAt = new Date(issuedAt + this.presignedUrlExpirySeconds * 1000).toISOString();

    return { url, expiresAt };
  }

  private async putBlobBytes(
    storageKey: string,
    stream: Readable,
    contentType: string,
    encryptionPolicy: EncryptionPolicy,
  ): Promise<Buffer | null> {
    const uploaded = await this.contentIngress.upload(
      storageKey,
      stream,
      contentType,
      0,
      encryptionPolicy === 'ENCRYPTED',
    );
    return uploaded.encryptionIv;
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) {
      throw new Error(
        'ENCRYPTED namespace인데 STORIX_ENCRYPTION_MASTER_KEY가 설정되지 않음 — 데이터 일관성 위반',
      );
    }
    return this.masterKey;
  }
}
