import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { DomainError } from '../common/domain-error.js';
import { parsePositiveInt } from '../common/env-parsing.js';
import { resolveFileSizeLimits, resolveMaxFileSizeBytes } from '../common/resource-limit.js';
import { FileExpiryBounds, parseExpiresInHeader, resolveFileExpiryBounds } from './file-expiry-policy.js';
import {
  mutationLeaseSeconds,
  VfsMutationReceiptRepository,
} from '../persistence/vfs-mutation-receipt.repository.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import type { ReceiptIdentity } from '../persistence/vfs-mutation-receipt.repository.js';
import { ContentPrecondition, VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { busyResponse, ErrorReceiptOwner, replayReceipt, storeErrorReceipt } from './mutation-receipt.js';
import { hashParts, identityOf, MutationHttpResult } from './mutation.service.js';
import { normalizeMimeType } from './mime.js';
import { PathResolver } from './path-resolver.js';
import { requireRootWithLimits } from './require-root.js';
import { decodeRevision } from './revision.js';
import {
  VfsChecksumMismatchError,
  VfsInvalidChecksumError,
  VfsInvalidExpiryError,
  VfsInvalidMutationRequestError,
  VfsPreconditionRequiredError,
} from './vfs.errors.js';
import { ContentIngressService } from './content-ingress.service.js';

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

// 조건이 유효하면 정규화 조건만 식별한다(기존 receipt fingerprint와 호환). 조건이 무효면
// 원본 헤더 값을 식별해 서로 다른 잘못된 헤더 조합이 같은 key에서 재생되지 않게 한다.
// path는 정규화에 성공하면 정규 경로, 실패하면 원본 경로 문자열이다.
function conditionIdentity(
  condition: ContentPrecondition | null,
  ifAbsent: string | undefined,
  ifRevision: string | undefined,
  expiresInSeconds?: number,
): string {
  if (condition) return JSON.stringify(condition);
  return JSON.stringify({
    invalid: {
      ifAbsent: ifAbsent ?? null,
      ifRevision: ifRevision ?? null,
      ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    },
  });
}

function fingerprint(
  path: string,
  condition: string,
  mimeType: string,
  bodyHash: string,
  expectedSha256?: string,
): string {
  const parts = ['POST', 'content/conditional', path, condition, mimeType, bodyHash];
  // 기존 checksum 미제공 receipt의 fingerprint를 보존한다.
  if (expectedSha256 !== undefined) parts.push(expectedSha256);
  return hashParts(parts);
}

@Injectable()
export class ConditionalContentService {
  private readonly maxFileSizeBytes: number;
  private readonly defaultMaxFileSizeBytes: number;
  private readonly maxUploadDurationMs: number;
  private readonly expiryBounds: FileExpiryBounds;

  constructor(
    private readonly paths: PathResolver,
    private readonly nodes: VfsNodeRepository,
    private readonly receipts: VfsMutationReceiptRepository,
    private readonly keys: StorageKeyGenerator,
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly contentIngress: ContentIngressService,
    private readonly blobs: BlobRepository,
    config: ConfigService,
  ) {
    const fileSizeLimits = resolveFileSizeLimits(
      config.get<string>('STORIX_DEFAULT_FILE_SIZE_BYTES'),
      config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'),
    );
    this.maxFileSizeBytes = fileSizeLimits.ceilingBytes;
    this.defaultMaxFileSizeBytes = fileSizeLimits.defaultBytes;
    this.maxUploadDurationMs =
      parsePositiveInt(config.get<string>('STORIX_MUTATION_MAX_UPLOAD_SECONDS'), 86400) * 1000;
    this.expiryBounds = resolveFileExpiryBounds(
      config.get<string>('STORIX_VFS_EXPIRY_MIN_SECONDS'),
      config.get<string>('STORIX_VFS_EXPIRY_MAX_SECONDS'),
    );
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
    expectedSha256?: string,
    expiresIn?: string,
  ): Promise<MutationHttpResult> {
    if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new VfsInvalidChecksumError();
    }
    // 만료 입력은 checksum처럼 본문 소비·receipt 생성 전에 검증한다.
    // 새 파일을 만드는 X-If-Absent: true 요청에서만 받는다.
    let expiresInSeconds: number | undefined;
    if (expiresIn !== undefined) {
      if (ifAbsent !== 'true' || ifRevision !== undefined) throw new VfsInvalidExpiryError();
      expiresInSeconds = parseExpiresInHeader(expiresIn, this.expiryBounds);
    }
    const identity = identityOf(namespaceId, scope, key);
    const { root, limits } = await requireRootWithLimits(this.nodes, namespaceId);
    const maxBytes = resolveMaxFileSizeBytes(
      limits.maxFileSizeBytes,
      this.maxFileSizeBytes,
      this.defaultMaxFileSizeBytes,
    );
    const mimeType = normalizeMimeType(contentType);
    let path = rawPath;
    let segments: string[] = [];
    let condition: ContentPrecondition | null = null;
    let parseError: DomainError | null = null;
    try {
      const resolved = this.paths.resolveConditional(rawPath);
      if (resolved.segments.length === 0) throw new VfsInvalidMutationRequestError();
      path = resolved.canonical;
      segments = resolved.segments;
      condition = parsePrecondition(ifAbsent, ifRevision);
      if (expiresInSeconds !== undefined && condition && 'ifAbsent' in condition) {
        condition = { ifAbsent: true, expiresInSeconds };
      }
    } catch (error) {
      if (error instanceof DomainError) parseError = error;
      else throw error;
    }

    const conditionKey = conditionIdentity(condition, ifAbsent, ifRevision, expiresInSeconds);
    const claim = await this.receipts.claim(identity, new Date());
    if (claim.kind === 'busy') return busyResponse(claim.retryAfterSeconds, requestId);
    try {
      const replayMaxBytes =
        claim.kind === 'complete'
          ? Math.max(maxBytes, Number(claim.receipt.requestBodyBytes ?? 0))
          : maxBytes;
      // 아래 두 오류와 hash/upload 중 한도 초과 413은 fingerprint를 만들기 전이라 저장하지 않는다.
      const declaredLength = contentLength === undefined ? null : Number(contentLength);
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        throw new VfsInvalidMutationRequestError();
      }
      if (declaredLength !== null && declaredLength > replayMaxBytes) {
        throw new VfsFileTooLargeError(replayMaxBytes);
      }

      if (claim.kind === 'complete' || parseError) {
        const lease =
          claim.kind === 'owner' && parseError ? this.startLeaseRenewal(identity, claim.generation) : null;
        try {
          const replayed = await this.contentIngress.hash(source, replayMaxBytes);
          const currentFingerprint = fingerprint(
            path,
            conditionKey,
            mimeType,
            replayed.sha256,
            expectedSha256,
          );
          if (claim.kind === 'complete') {
            return replayReceipt(claim.receipt, 'POST', currentFingerprint, requestId);
          }
          const error =
            lease?.lost || !(await this.receipts.renew(identity, claim.generation))
              ? new Error('VFS mutation claim lost')
              : parseError;
          return await storeErrorReceipt(
            this.receipts,
            {
              identity,
              generation: claim.generation,
              fingerprint: currentFingerprint,
              method: 'POST',
              requestBodyBytes: replayed.size,
            },
            error,
            requestId,
          );
        } finally {
          await lease?.stop();
        }
      }

      const validCondition = condition as ContentPrecondition;
      const storageKey = this.keys.generate();
      const lease = this.startLeaseRenewal(identity, claim.generation);
      const durationTimer = setTimeout(
        () => source.destroy(new Error('mutation upload duration exceeded')),
        this.maxUploadDurationMs,
      );
      durationTimer.unref();
      let uploaded: Awaited<ReturnType<ContentIngressService['upload']>>;
      try {
        uploaded = await this.contentIngress.upload(
          storageKey,
          source,
          mimeType,
          maxBytes,
          limits.encryptionPolicy === 'ENCRYPTED',
        );
      } finally {
        clearTimeout(durationTimer);
        await lease.stop();
      }
      const owner: ErrorReceiptOwner = {
        identity,
        generation: claim.generation,
        fingerprint: fingerprint(path, conditionKey, mimeType, uploaded.sha256, expectedSha256),
        method: 'POST',
        requestBodyBytes: uploaded.size,
      };
      try {
        if (expectedSha256 !== undefined && uploaded.sha256 !== expectedSha256) {
          throw new VfsChecksumMismatchError();
        }
        if (lease.lost || !(await this.receipts.renew(identity, claim.generation))) {
          throw new Error('VFS mutation claim lost');
        }
        const applied = await this.nodes.withMutation(
          namespaceId,
          root.id,
          (tx) =>
            this.nodes.putConditionalContent(tx, segments, validCondition, {
              storageKey,
              size: String(uploaded.size),
              mimeType,
              sha256: uploaded.sha256,
              encryptionIv: uploaded.encryptionIv,
            }),
          (tx, result) =>
            this.receipts.complete(
              tx,
              owner.identity,
              owner.generation,
              owner.fingerprint,
              owner.method,
              {
                status: result.value.status,
                body: { resource: result.value.resource, affectedRevisions: result.affectedRevisions },
                headers: { 'x-request-id': requestId },
              },
              owner.requestBodyBytes,
            ),
        );
        return {
          status: applied.value.status,
          body: { resource: applied.value.resource, affectedRevisions: applied.affectedRevisions },
          headers: { 'x-request-id': requestId },
        };
      } catch (error) {
        // commit 결과가 불명확한 DB 장애(ack 유실)에서 참조된 객체를 지우면 공개 파일이 손실된다.
        // 참조 여부를 확인하지 못해도 보존하고 orphan GC에 맡긴다.
        const referenced = await this.blobs
          .findKnownStorageKeys([storageKey])
          .then((known) => known.has(storageKey))
          .catch(() => true);
        if (!referenced) await this.storage.delete(storageKey).catch(() => undefined);
        return await storeErrorReceipt(this.receipts, owner, error, requestId);
      }
    } catch (error) {
      if (claim.kind === 'owner') await this.receipts.release(identity, claim.generation);
      throw error;
    }
  }

  private startLeaseRenewal(identity: ReceiptIdentity, generation: number) {
    let lost = false;
    let renewal: Promise<void> | null = null;
    const timer = setInterval(
      () => {
        if (renewal) return;
        renewal = this.receipts
          .renew(identity, generation)
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            renewal = null;
          });
      },
      Math.max(250, Math.floor((mutationLeaseSeconds() * 1000) / 3)),
    );
    timer.unref();

    return {
      get lost() {
        return lost;
      },
      async stop() {
        clearInterval(timer);
        if (renewal) await renewal;
      },
    };
  }
}
