import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { parsePositiveInt } from '../common/env-parsing.js';
import { buildContentDisposition } from './content-disposition.js';
import { EncryptingPutTarget, getEncrypted } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { EncryptionPolicy } from '../persistence/entities/namespace.entity.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { uploadStream } from '../storage/stream-upload.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { toNodeResponse, VfsNodeResponseDto } from './dto/node-response.dto.js';
import { normalizeMimeType } from './mime.js';
import { PathResolver } from './path-resolver.js';
import { parseRange } from './range.js';
import { resolveEffectiveLimit } from '../common/resource-limit.js';
import { requireRootWithLimits } from './require-root.js';
import { VfsIsDirectoryError, VfsNodeNotFoundError, VfsPresignedEncryptedUnsupportedError } from './vfs.errors.js';

const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export interface PutContentOptions {
  readonly contentType: string | undefined;
  readonly contentLength: string | undefined;
  readonly ifMatch: string | undefined;
  readonly force: boolean;
  readonly parents: boolean;
}

export interface ContentPayload {
  readonly name: string;
  readonly mimeType: string;
  readonly status: number;
  readonly contentLength: number;
  readonly contentRange?: string;
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
  private readonly presignedUrlExpirySeconds: number;

  constructor(
    private readonly pathResolver: PathResolver,
    private readonly repo: VfsNodeRepository,
    private readonly keyGenerator: StorageKeyGenerator,
    @Inject(BLOB_STORAGE) private readonly blobStorage: BlobStorage,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
    config: ConfigService,
  ) {
    this.maxFileSizeBytes = parsePositiveInt(config.getOrThrow<string>('MAX_FILE_SIZE_BYTES'), 1);
    this.presignedUrlExpirySeconds = parsePositiveInt(config.get<string>('PRESIGNED_URL_EXPIRY_SECONDS'), 300);
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

    const maxFileSizeBytes = resolveEffectiveLimit(
      limits.maxFileSizeBytes === null ? null : Number(limits.maxFileSizeBytes),
      this.maxFileSizeBytes,
    );

    const contentLength = options.contentLength !== undefined ? Number(options.contentLength) : undefined;
    if (contentLength !== undefined && contentLength > maxFileSizeBytes) {
      throw new VfsFileTooLargeError(maxFileSizeBytes);
    }

    const mimeType = normalizeMimeType(options.contentType);
    const storageKey = this.keyGenerator.generate();
    const putTarget =
      limits.encryptionPolicy === 'ENCRYPTED'
        ? new EncryptingPutTarget(this.blobStorage, this.requireMasterKey())
        : this.blobStorage;
    const uploaded = await uploadStream(putTarget, storageKey, source, mimeType, maxFileSizeBytes);
    const encryptionIv = putTarget instanceof EncryptingPutTarget ? putTarget.getIv() : null;

    const outcome = await this.repo.putFileContent(
      namespaceId,
      root.id,
      segments,
      options.parents,
      { storageKey, size: String(uploaded.size), mimeType, sha256: uploaded.sha256, encryptionIv },
      parseIfMatch(options.ifMatch),
      options.force,
    );

    return {
      status: outcome.kind === 'created' ? 201 : 200,
      body: toNodeResponse(outcome.node, canonical),
    };
  }

  async getContent(
    namespaceId: string,
    rawPath: string,
    rangeHeader: string | undefined,
  ): Promise<ContentPayload> {
    const { root, limits } = await requireRootWithLimits(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);
    const target = segments.length === 0 ? root : await this.repo.resolvePath(namespaceId, root.id, segments);

    if (!target) {
      throw new VfsNodeNotFoundError(canonical);
    }
    if (target.type === 'DIRECTORY') {
      throw new VfsIsDirectoryError(canonical);
    }

    const blobInfo = await this.repo.getBlobStorageInfo(namespaceId, target.blobId as string);
    const { storageKey, encryptionIv } = blobInfo as { storageKey: string; encryptionIv: Buffer | null };
    const totalSize = Number(target.size);
    const mimeType = target.mimeType ?? 'application/octet-stream';

    if (!rangeHeader) {
      const stream =
        limits.encryptionPolicy === 'ENCRYPTED'
          ? await getEncrypted(this.blobStorage, storageKey, encryptionIv as Buffer, this.requireMasterKey())
          : await this.blobStorage.get(storageKey);
      return { name: target.name, mimeType, status: 200, contentLength: totalSize, stream };
    }

    const range = parseRange(rangeHeader, totalSize);
    const stream =
      limits.encryptionPolicy === 'ENCRYPTED'
        ? await getEncrypted(this.blobStorage, storageKey, encryptionIv as Buffer, this.requireMasterKey(), range)
        : await this.blobStorage.get(storageKey, range);

    return {
      name: target.name,
      mimeType,
      status: 206,
      contentRange: `bytes ${range.start}-${range.end}/${totalSize}`,
      contentLength: range.end - range.start + 1,
      stream,
    };
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

    const url = await this.blobStorage.getPresignedUrl(
      storageKey,
      this.presignedUrlExpirySeconds,
      buildContentDisposition(target.name),
    );
    const expiresAt = new Date(Date.now() + this.presignedUrlExpirySeconds * 1000).toISOString();

    return { url, expiresAt };
  }

  private async putBlobBytes(
    storageKey: string,
    stream: Readable,
    contentType: string,
    encryptionPolicy: EncryptionPolicy,
  ): Promise<Buffer | null> {
    if (encryptionPolicy !== 'ENCRYPTED') {
      await this.blobStorage.put(storageKey, stream, contentType);
      return null;
    }

    const target = new EncryptingPutTarget(this.blobStorage, this.requireMasterKey());
    await target.put(storageKey, stream, contentType);
    return target.getIv();
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) {
      throw new Error('ENCRYPTED namespace인데 ENCRYPTION_MASTER_KEY가 설정되지 않음 — 데이터 일관성 위반');
    }
    return this.masterKey;
  }
}
