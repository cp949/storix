// archive 요청 receipt·source capture·ZIP stream·조건부 FILE commit을 순서대로 조정한다.
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { getEncrypted } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { resolveFileSizeLimits, resolveMaxFileSizeBytes } from '../common/resource-limit.js';
import { CapabilityService } from '../capability/capability.service.js';
import { ArchiveSourceRepository } from '../persistence/archive-source.repository.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { ContentIngressService } from './content-ingress.service.js';
import { parseArchiveRequest } from './dto/archive-request.dto.js';
import { ARCHIVE_CONFIG, type ArchiveConfig } from './archive-config.js';
import { ArchiveGate } from './archive-gate.js';
import { PathResolver } from './path-resolver.js';
import { requireRootWithLimits } from './require-root.js';
import { VfsArchiveDeadlineExceededError, VfsArchiveInvalidRequestError } from './vfs.errors.js';
import { DomainError } from '../common/domain-error.js';
import {
  assertExpiryWithinBounds,
  parseExpiresInHeader,
  resolveFileExpiryBounds,
} from './file-expiry-policy.js';
import { identityOf, hashParts, type MutationHttpResult } from './mutation.service.js';
import {
  busyResponse,
  replayReceipt,
  storeErrorReceipt,
  type ErrorReceiptOwner,
} from './mutation-receipt.js';
import { startLeaseRenewal } from './receipt-lease-renewal.js';
import { createZipWriter } from './zip-writer.js';
import { deleteUnreferencedUpload } from './unreferenced-upload-cleanup.js';
import { verifiedArchiveSource } from './archive-source-stream.js';

const METHOD = 'POST';
const ROUTE = 'fs/archive';

/** archive 요청의 receipt·stream 실행과 FILE commit을 조정한다. */
@Injectable()
export class ArchiveService {
  private readonly pathResolver = new PathResolver();
  private readonly fileSizeLimits: ReturnType<typeof resolveFileSizeLimits>;
  private readonly expiryBounds;

  constructor(
    private readonly nodes: VfsNodeRepository,
    private readonly receipts: VfsMutationReceiptRepository,
    private readonly sources: ArchiveSourceRepository,
    private readonly capabilities: CapabilityService,
    private readonly gate: ArchiveGate,
    private readonly keys: StorageKeyGenerator,
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly ingress: ContentIngressService,
    config: ConfigService,
    @Inject(ARCHIVE_CONFIG) private readonly archiveConfig: ArchiveConfig,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
    private readonly blobs: BlobRepository,
  ) {
    this.fileSizeLimits = resolveFileSizeLimits(
      config.get<string>('STORIX_DEFAULT_FILE_SIZE_BYTES'),
      config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'),
    );
    this.expiryBounds = resolveFileExpiryBounds(
      config.get<string>('STORIX_VFS_EXPIRY_MIN_SECONDS'),
      config.get<string>('STORIX_VFS_EXPIRY_MAX_SECONDS'),
    );
  }

  /** 요청 receipt를 판정하고 원본을 검증해 조건부 ZIP FILE을 생성한다. */
  async execute(
    namespaceId: string,
    scope: string | undefined,
    key: string | undefined,
    rawBody: Buffer,
    expiresIn: string | undefined,
    requestId: string,
    responseSignal?: AbortSignal,
  ): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const { root, limits } = await requireRootWithLimits(this.nodes, namespaceId);
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
    let request: ReturnType<typeof parseArchiveRequest> | null = null;
    let targetSegments: string[] = [];
    let parseError: Error | null = null;
    let expiresInSeconds: number | undefined;
    try {
      request = parseArchiveRequest(JSON.parse(body.toString('utf8')) as unknown);
      const target = this.pathResolver.resolveConditional(request.target);
      if (target.segments.length === 0) throw new VfsArchiveInvalidRequestError();
      targetSegments = target.segments;
      if (expiresIn !== undefined) {
        expiresInSeconds = parseExpiresInHeader(expiresIn, null);
        assertExpiryWithinBounds(expiresInSeconds, this.expiryBounds);
      }
    } catch (error) {
      parseError = error instanceof DomainError ? error : new VfsArchiveInvalidRequestError();
    }
    const fingerprint = hashParts([
      METHOD,
      ROUTE,
      request ? JSON.stringify({ target: targetSegments, entries: request.entries }) : 'invalid',
      createHash('sha256').update(body).digest('hex'),
      expiresIn ?? '',
    ]);
    const claim = await this.receipts.claim(identity, new Date());
    if (claim.kind === 'busy') return busyResponse(claim.retryAfterSeconds, requestId);
    if (claim.kind === 'complete') return replayReceipt(claim.receipt, METHOD, fingerprint, requestId);
    const owner: ErrorReceiptOwner = {
      identity,
      generation: claim.generation,
      fingerprint,
      method: METHOD,
      requestBodyBytes: body.length,
    };
    let clientClosed = false;
    try {
      if (parseError) return await storeErrorReceipt(this.receipts, owner, parseError, requestId);
      this.capabilities.requireEnabled(namespaceId, 'archive');
      const gateLease = this.gate.tryAcquire();
      if (!gateLease) {
        await this.receipts.release(identity, claim.generation);
        return {
          status: 503,
          body: { code: 'VFS_ARCHIVE_BUSY', message: 'archive 실행 한도 초과', requestId },
          headers: { 'retry-after': String(this.archiveConfig.retryAfterSeconds), 'x-request-id': requestId },
        };
      }
      const controller = new AbortController();
      const abortFromResponse = () => {
        clientClosed = true;
        controller.abort(new Error('archive response closed'));
      };
      responseSignal?.addEventListener('abort', abortFromResponse, { once: true });
      const timeout = setTimeout(
        () => controller.abort(new VfsArchiveDeadlineExceededError()),
        this.archiveConfig.maxSeconds * 1000,
      );
      timeout.unref();
      const lease = startLeaseRenewal(this.receipts, identity, claim.generation);
      let storageKey: string | undefined;
      let zipExecution: ReturnType<typeof createZipWriter> | undefined;
      let ownerForError = owner;
      try {
        const normalizedRequest = request!;
        const capture = await this.sources.capture(
          namespaceId,
          root.id,
          {
            target: `/${targetSegments.join('/')}`,
            entries: normalizedRequest.entries,
          },
          {
            maxEntries: this.archiveConfig.maxEntries,
            maxSourceBytes: this.archiveConfig.maxSourceBytes,
            maxSeconds: this.archiveConfig.maxSeconds,
          },
        );
        if (limits.encryptionPolicy === 'ENCRYPTED' && !this.masterKey)
          throw new Error('ENCRYPTED namespace master key missing');
        const maxFileBytes = resolveMaxFileSizeBytes(
          limits.maxFileSizeBytes,
          this.fileSizeLimits.ceilingBytes,
          this.fileSizeLimits.defaultBytes,
        );
        const resultLimit = this.archiveConfig.maxResultBytes;
        const zipEntries = capture.entries.map((entry) => ({ ...entry, modifiedAt: entry.updatedAt }));
        const zip = createZipWriter(
          zipEntries,
          async (entry, _index, signal) => {
            const source =
              limits.encryptionPolicy === 'ENCRYPTED'
                ? await getEncrypted(
                    this.storage,
                    entry.storageKey,
                    entry.encryptionIv!,
                    this.masterKey!,
                    undefined,
                    signal,
                  )
                : await this.storage.get(entry.storageKey, undefined, signal);
            return verifiedArchiveSource(source, entry.plaintextBytes, entry.sha256);
          },
          {
            compressionLevel: this.archiveConfig.compressionLevel,
            maxResultBytes: resultLimit,
            signal: controller.signal,
          },
        );
        zipExecution = zip;
        storageKey = this.keys.generate();
        const uploaded = await this.ingress.upload(
          storageKey,
          zip.output,
          'application/zip',
          maxFileBytes,
          limits.encryptionPolicy === 'ENCRYPTED',
          controller.signal,
        );
        await zip.settled;
        ownerForError = { ...owner, fingerprint, requestBodyBytes: body.length };
        if (lease.lost || !(await this.receipts.renew(identity, claim.generation)))
          throw new Error('VFS mutation claim lost');
        const result = await this.nodes.withMutation(
          namespaceId,
          root.id,
          async (tx) => {
            await this.sources.assertDeadline(tx.manager, capture.deadlineAt);
            return this.nodes.putConditionalContent(
              tx,
              targetSegments,
              { ifAbsent: true, ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }) },
              {
                storageKey: storageKey!,
                size: String(uploaded.size),
                mimeType: 'application/zip',
                sha256: uploaded.sha256,
                encryptionIv: uploaded.encryptionIv,
              },
            );
          },
          async (tx, applied) => {
            await this.sources.assertDeadline(tx.manager, capture.deadlineAt);
            await this.receipts.complete(
              tx,
              identity,
              claim.generation,
              fingerprint,
              METHOD,
              {
                status: applied.value.status,
                body: {
                  resource: applied.value.resource,
                  affectedRevisions: applied.affectedRevisions,
                  entryCount: capture.entries.length,
                },
                headers: { 'x-request-id': requestId },
              },
              body.length,
            );
          },
        );
        return {
          status: result.value.status,
          body: {
            resource: result.value.resource,
            affectedRevisions: result.affectedRevisions,
            entryCount: capture.entries.length,
          },
          headers: { 'x-request-id': requestId },
        };
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error)
          error = controller.signal.reason;
        zipExecution?.abort(error instanceof Error ? error : new Error('archive failed'));
        await zipExecution?.settled.catch(() => undefined);
        if (storageKey) await deleteUnreferencedUpload(this.blobs, this.storage, storageKey, error);
        return await storeErrorReceipt(this.receipts, ownerForError, error, requestId);
      } finally {
        clearTimeout(timeout);
        responseSignal?.removeEventListener('abort', abortFromResponse);
        await lease.stop();
        gateLease.release();
      }
    } catch (error) {
      await this.receipts.release(identity, claim.generation).catch(() => undefined);
      if (clientClosed) return { status: 499, body: null, headers: {} };
      throw error;
    }
  }
}
