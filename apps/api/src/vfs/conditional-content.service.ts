import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { DomainError } from '../common/domain-error.js';
import { parsePositiveInt } from '../common/env-parsing.js';
import { resolveEffectiveLimit } from '../common/resource-limit.js';
import { EncryptingPutTarget } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import {
  mutationLeaseSeconds,
  VfsMutationReceiptRepository,
} from '../persistence/vfs-mutation-receipt.repository.js';
import { ContentPrecondition, VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { hashStream, uploadStream } from '../storage/stream-upload.js';
import { errorResponse, hashParts, identityOf, MutationHttpResult } from './mutation.service.js';
import { normalizeMimeType } from './mime.js';
import { PathResolver } from './path-resolver.js';
import { requireRootWithLimits } from './require-root.js';
import { decodeRevision } from './revision.js';
import { VfsInvalidMutationRequestError, VfsPreconditionRequiredError } from './vfs.errors.js';

function parsePrecondition(
  ifAbsent: string | undefined,
  ifRevision: string | undefined,
): ContentPrecondition {
  if (ifAbsent === undefined && ifRevision === undefined) throw new VfsPreconditionRequiredError();
  if (ifAbsent !== undefined && ifRevision !== undefined) throw new VfsInvalidMutationRequestError();
  if (ifAbsent !== undefined) {
    if (ifAbsent !== 'true') throw new VfsInvalidMutationRequestError();
    return { ifAbsent: true };
  }
  if (!ifRevision) throw new VfsInvalidMutationRequestError();
  decodeRevision(ifRevision);
  return { ifRevision };
}

function fingerprint(
  path: string,
  condition: ContentPrecondition | null,
  mimeType: string,
  bodyHash: string,
): string {
  return hashParts([
    'POST',
    'content/conditional',
    path,
    JSON.stringify(condition ?? 'invalid'),
    mimeType,
    bodyHash,
  ]);
}

@Injectable()
export class ConditionalContentService {
  private readonly maxFileSizeBytes: number;
  private readonly maxUploadDurationMs: number;

  constructor(
    private readonly paths: PathResolver,
    private readonly nodes: VfsNodeRepository,
    private readonly receipts: VfsMutationReceiptRepository,
    private readonly keys: StorageKeyGenerator,
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
    config: ConfigService,
  ) {
    this.maxFileSizeBytes = parsePositiveInt(config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'), 5368709120);
    this.maxUploadDurationMs =
      parsePositiveInt(config.get<string>('STORIX_MUTATION_MAX_UPLOAD_SECONDS'), 86400) * 1000;
  }

  async put(
    namespaceId: string,
    scope: string | undefined,
    key: string | undefined,
    rawPath: string,
    ifAbsent: string | undefined,
    ifRevision: string | undefined,
    source: Readable,
    contentType: string | undefined,
    contentLength: string | undefined,
    requestId: string,
  ): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const { root, limits } = await requireRootWithLimits(this.nodes, namespaceId);
    const maxBytes = resolveEffectiveLimit(
      limits.maxFileSizeBytes === null ? null : Number(limits.maxFileSizeBytes),
      this.maxFileSizeBytes,
    );
    const mimeType = normalizeMimeType(contentType);
    let path = rawPath;
    let segments: string[] = [];
    let condition: ContentPrecondition | null = null;
    let parseError: DomainError | null = null;
    try {
      const resolved = this.paths.resolve(rawPath);
      if (resolved.segments.length === 0) throw new VfsInvalidMutationRequestError();
      path = resolved.canonical;
      segments = resolved.segments;
      condition = parsePrecondition(ifAbsent, ifRevision);
    } catch (error) {
      if (error instanceof DomainError) parseError = error;
      else throw error;
    }

    const claim = await this.receipts.claim(identity, new Date());
    if (claim.kind === 'busy') {
      return {
        status: 409,
        body: { code: 'MUTATION_IN_PROGRESS', message: 'mutation 처리 중', requestId },
        headers: { 'retry-after': String(claim.retryAfterSeconds), 'x-request-id': requestId },
      };
    }
    try {
      const declaredLength = contentLength === undefined ? null : Number(contentLength);
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        throw new VfsInvalidMutationRequestError();
      }
      if (declaredLength !== null && declaredLength > maxBytes) throw new VfsFileTooLargeError(maxBytes);

      if (claim.kind === 'complete' || parseError) {
        const replayed = await hashStream(source, maxBytes);
        const currentFingerprint = fingerprint(path, condition, mimeType, replayed.sha256);
        if (claim.kind === 'complete') {
          if (claim.receipt.method !== 'POST' || claim.receipt.fingerprint !== currentFingerprint) {
            return {
              status: 409,
              body: { code: 'MUTATION_KEY_REUSED', message: '다른 요청에 사용한 mutation key', requestId },
              headers: { 'x-request-id': requestId },
            };
          }
          return {
            status: claim.receipt.responseStatus as number,
            body: JSON.parse(claim.receipt.responseBody as string) as unknown,
            headers: JSON.parse(claim.receipt.responseHeaders as string) as Record<string, string>,
          };
        }
        const result = errorResponse(parseError as DomainError, requestId);
        await this.nodes.withMutation(
          namespaceId,
          root.id,
          async () => null,
          (tx) => this.receipts.complete(tx, identity, claim.generation, currentFingerprint, 'POST', result),
        );
        return result;
      }

      const validCondition = condition as ContentPrecondition;
      const storageKey = this.keys.generate();
      const putTarget =
        limits.encryptionPolicy === 'ENCRYPTED'
          ? new EncryptingPutTarget(this.storage, this.requireMasterKey())
          : this.storage;
      let leaseLost = false;
      let renewal: Promise<void> | null = null;
      const renewalTimer = setInterval(
        () => {
          if (renewal) return;
          renewal = this.receipts
            .renew(identity, claim.generation, new Date())
            .then((ok) => {
              if (!ok) leaseLost = true;
            })
            .catch(() => {
              leaseLost = true;
            })
            .finally(() => {
              renewal = null;
            });
        },
        Math.max(250, Math.floor((mutationLeaseSeconds() * 1000) / 3)),
      );
      renewalTimer.unref();
      const durationTimer = setTimeout(
        () => source.destroy(new Error('mutation upload duration exceeded')),
        this.maxUploadDurationMs,
      );
      durationTimer.unref();
      let uploaded: Awaited<ReturnType<typeof uploadStream>>;
      try {
        uploaded = await uploadStream(putTarget, storageKey, source, mimeType, maxBytes);
      } finally {
        clearInterval(renewalTimer);
        clearTimeout(durationTimer);
        if (renewal) await renewal;
      }
      try {
        if (leaseLost || !(await this.receipts.renew(identity, claim.generation, new Date()))) {
          throw new Error('VFS mutation claim lost');
        }
        const currentFingerprint = fingerprint(path, validCondition, mimeType, uploaded.sha256);
        const encryptionIv = putTarget instanceof EncryptingPutTarget ? putTarget.getIv() : null;
        const applied = await this.nodes.withMutation(
          namespaceId,
          root.id,
          (tx) =>
            this.nodes.putConditionalContent(tx, segments, validCondition, {
              storageKey,
              size: String(uploaded.size),
              mimeType,
              sha256: uploaded.sha256,
              encryptionIv,
            }),
          (tx, result) =>
            this.receipts.complete(tx, identity, claim.generation, currentFingerprint, 'POST', {
              status: result.value.status,
              body: { resource: result.value.resource, affectedRevisions: result.affectedRevisions },
              headers: { 'x-request-id': requestId },
            }),
        );
        return {
          status: applied.value.status,
          body: { resource: applied.value.resource, affectedRevisions: applied.affectedRevisions },
          headers: { 'x-request-id': requestId },
        };
      } catch (error) {
        await this.storage.delete(storageKey).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (claim.kind === 'owner') await this.receipts.release(identity, claim.generation);
      throw error;
    }
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) throw new Error('ENCRYPTED namespace master key missing');
    return this.masterKey;
  }
}
