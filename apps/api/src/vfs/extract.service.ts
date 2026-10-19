// extract 요청의 receipt·source capture·entry 검증/업로드·조건부 트리 commit을 순서대로 조정한다.
// stream 소유권: raw GET → (gunzip) → tar reader, 또는 range GET → (inflate) → CRC 검증. 어느 경로든 끝나면 close를 기다린다.
// 규칙은 docs/design/17-file-extract.md "실행"과 "무결성과 복구 경계"를 따른다.
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PassThrough, Transform, pipeline, type Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { CapabilityService } from '../capability/capability.service.js';
import { DomainError } from '../common/domain-error.js';
import { parsePositiveInt } from '../common/env-parsing.js';
import {
  resolveEffectiveLimit,
  resolveFileSizeLimits,
  resolveMaxFileSizeBytes,
} from '../common/resource-limit.js';
import { waitForClose } from '../common/stream-close.js';
import { getEncrypted } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import {
  ExtractSourceRepository,
  type ExtractSourceCapture,
} from '../persistence/extract-source.repository.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import type { ExtractCommitEntry } from '../persistence/vfs-node.repository.extract.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import type { BlobRange, BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { ArchiveGate } from './archive-gate.js';
import { ContentIngressService } from './content-ingress.service.js';
import { parseExtractRequest, type ExtractRequest } from './dto/extract-request.dto.js';
import { EXTRACT_CONFIG, EXTRACT_GATE, type ExtractConfig } from './extract-config.js';
import { ExtractEntryPlanner, type PlannedEntry } from './extract-entry-plan.js';
import { detectExtractFormat, type ExtractFormat } from './extract-format.js';
import { ExtractReaderError } from './extract-reader-error.js';
import { identityOf, hashParts, type MutationHttpResult } from './mutation.service.js';
import {
  busyResponse,
  errorResponse,
  replayReceipt,
  storeErrorReceipt,
  type ErrorReceiptOwner,
} from './mutation-receipt.js';
import { startLeaseRenewal } from './receipt-lease-renewal.js';
import { requireRootWithLimits } from './require-root.js';
import { readTarEntries, type ExtractSourceEntry } from './tar-reader.js';
import { deleteUnreferencedUpload } from './unreferenced-upload-cleanup.js';
import {
  VfsExtractBusyError,
  VfsExtractDeadlineExceededError,
  VfsExtractInvalidEntryError,
  VfsExtractInvalidRequestError,
  VfsExtractTooLargeError,
  VfsExtractUnsupportedFormatError,
} from './vfs.errors.js';
import { readZipEntries } from './zip-reader.js';

const METHOD = 'POST';
const ROUTE = 'fs/extract';
const HEAD_BYTES = 512;
// 압축비는 이 크기 이상부터 판정한다. 작은 archive의 일시적 비율 요동을 막는다.
const RATIO_FLOOR = 1n << 20n;
const MAX_TAR_HEADER_BYTES = 65536;
const CLEANUP_CONCURRENCY = 8;

interface ReadEntry {
  readonly planned: PlannedEntry;
  readonly size: bigint;
  readonly commit: ExtractCommitEntry;
}

/** reader 순회가 끝난 뒤 service가 기다려야 하는 stream 묶음이다. */
interface SourcePipeline {
  readonly entries: AsyncGenerator<ExtractSourceEntry>;

  /** 성공 경로에서 gzip EOF·trailer까지 소비돼 모든 stream이 끝났는지 기다린다. */
  settled(): Promise<void>;

  /** 실패 경로에서 남은 stream을 모두 destroy하고 close를 기다린다. */
  abort(error: Error): Promise<void>;
}

/** extract 요청의 receipt·stream 실행과 트리 commit을 조정한다. */
@Injectable()
export class ExtractService {
  private readonly fileSizeLimits: ReturnType<typeof resolveFileSizeLimits>;

  constructor(
    private readonly nodes: VfsNodeRepository,
    private readonly receipts: VfsMutationReceiptRepository,
    private readonly sources: ExtractSourceRepository,
    private readonly capabilities: CapabilityService,
    @Inject(EXTRACT_GATE) private readonly gate: ArchiveGate,
    private readonly keys: StorageKeyGenerator,
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly ingress: ContentIngressService,
    config: ConfigService,
    @Inject(EXTRACT_CONFIG) private readonly extractConfig: ExtractConfig,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
    private readonly blobs: BlobRepository,
  ) {
    this.fileSizeLimits = resolveFileSizeLimits(
      config.get<string>('STORIX_DEFAULT_FILE_SIZE_BYTES'),
      config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'),
    );
  }

  /**
   * 요청 receipt를 판정하고 source를 풀어 destination에 조건부로 반영한다.
   *
   * 순서는 헤더·namespace, JSON 해석, receipt claim(재생이면 여기서 끝), capability, gate, source capture,
   * 형식 판별, entry 검증·업로드, 마지막 commit이다.
   * dryRun 성공은 receipt를 남기지 않고 claim을 해제한다.
   */
  async execute(
    namespaceId: string,
    scope: string | undefined,
    key: string | undefined,
    rawBody: Buffer,
    requestId: string,
    responseSignal?: AbortSignal,
  ): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const { root, limits } = await requireRootWithLimits(this.nodes, namespaceId);
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
    let request: ExtractRequest | null = null;
    let parseError: Error | null = null;
    try {
      request = parseExtractRequest(JSON.parse(body.toString('utf8')) as unknown);
    } catch (error) {
      parseError = error instanceof DomainError ? error : new VfsExtractInvalidRequestError();
    }
    const fingerprint = hashParts([
      METHOD,
      ROUTE,
      request ? JSON.stringify(request) : 'invalid',
      createHash('sha256').update(body).digest('hex'),
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
      this.capabilities.requireEnabled(namespaceId, 'extract');
      const controller = new AbortController();
      const abortFromResponse = () => {
        clientClosed = true;
        controller.abort(new Error('extract response closed'));
      };
      const gateLease = this.gate.tryAcquire();
      if (!gateLease) {
        await this.receipts.release(identity, claim.generation);
        const busy = new VfsExtractBusyError(this.extractConfig.retryAfterSeconds);
        const response = errorResponse(busy, requestId);
        return {
          ...response,
          headers: { ...response.headers, 'retry-after': String(busy.retryAfterSeconds) },
        };
      }
      // gate 슬롯을 얻은 뒤에는 어떤 경로로 나가도 finally가 슬롯을 돌려준다.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let lease: ReturnType<typeof startLeaseRenewal> | undefined;
      const uploadedKeys: string[] = [];
      let source: SourcePipeline | undefined;
      try {
        // claim·capability 검사 중에 이미 끊긴 client의 signal은 abort 이벤트를 다시 내지 않는다.
        if (responseSignal?.aborted) abortFromResponse();
        else responseSignal?.addEventListener('abort', abortFromResponse, { once: true });
        timeout = setTimeout(
          () => controller.abort(new VfsExtractDeadlineExceededError()),
          this.extractConfig.maxSeconds * 1000,
        );
        timeout.unref();
        lease = startLeaseRenewal(this.receipts, identity, claim.generation);
        if (controller.signal.aborted) throw controller.signal.reason;
        const req = request!;
        const capture = await this.sources.capture(
          namespaceId,
          root.id,
          {
            sourceSegments: req.sourceSegments,
            sourceRevision: req.sourceRevision,
            destinationSegments: req.destinationSegments,
            ...(req.destinationRevision === undefined
              ? {}
              : { destinationRevision: req.destinationRevision }),
          },
          this.extractConfig.maxSeconds,
        );
        controller.signal.throwIfAborted();
        if ((limits.encryptionPolicy === 'ENCRYPTED' || capture.source.encryptionIv) && !this.masterKey)
          throw new Error('ENCRYPTED namespace master key missing');
        const maxFileBytes = resolveMaxFileSizeBytes(
          limits.maxFileSizeBytes,
          this.fileSizeLimits.ceilingBytes,
          this.fileSizeLimits.defaultBytes,
        );
        const encrypted = limits.encryptionPolicy === 'ENCRYPTED';
        const openSource = (range?: BlobRange): Promise<Readable> =>
          capture.source.encryptionIv
            ? getEncrypted(
                this.storage,
                capture.source.storageKey,
                capture.source.encryptionIv,
                this.masterKey!,
                range,
                controller.signal,
              )
            : this.storage.get(capture.source.storageKey, range, controller.signal);
        const readRange = this.rangeReader(capture, openSource);

        const headLength =
          capture.source.size < BigInt(HEAD_BYTES) ? capture.source.size : BigInt(HEAD_BYTES);
        const format = detectExtractFormat(await readRange(0n, Number(headLength)));
        if (!format) throw new VfsExtractUnsupportedFormatError('magic 불일치');

        source =
          format === 'zip'
            ? this.openZipPipeline(capture, openSource, readRange, controller.signal)
            : await this.openTarPipeline(format, capture, openSource, controller.signal);
        const read = await this.readEntries(
          format,
          req,
          source.entries,
          maxFileBytes,
          encrypted,
          uploadedKeys,
          controller.signal,
        );
        await source.settled();
        source = undefined;
        controller.signal.throwIfAborted();

        if (req.dryRun) {
          await this.receipts.release(identity, claim.generation);
          return {
            status: 200,
            body: {
              format,
              entryCount: read.length,
              totalBytes: Number(read.reduce((sum, entry) => sum + entry.size, 0n)),
              entries: read.map((entry) => ({
                name: entry.planned.name,
                type: entry.planned.type,
                size: Number(entry.size),
              })),
            },
            headers: { 'x-request-id': requestId },
          };
        }

        if (lease.lost || !(await this.receipts.renew(identity, claim.generation)))
          throw new Error('VFS mutation claim lost');
        controller.signal.throwIfAborted();
        const maxSyncDeleteNodes = resolveEffectiveLimit(
          limits.maxSyncDeleteNodes,
          parsePositiveInt(process.env.STORIX_MAX_SYNC_DELETE_NODES, 1000),
        );
        let response: MutationHttpResult | undefined;
        await this.nodes.withMutation(
          namespaceId,
          root.id,
          async (tx) => {
            await this.sources.assertDeadline(tx.manager, capture.deadlineAt);
            controller.signal.throwIfAborted();
            return this.nodes.applyExtract(tx, {
              destinationSegments: req.destinationSegments,
              ...(req.destinationRevision === undefined
                ? {}
                : { destinationRevision: req.destinationRevision }),
              mode: req.mode,
              entries: read.map((entry) => entry.commit),
              maxSyncDeleteNodes,
            });
          },
          async (tx, applied) => {
            await this.sources.assertDeadline(tx.manager, capture.deadlineAt);
            controller.signal.throwIfAborted();
            // version bump 뒤 DTO를 읽어 receipt와 최초 HTTP 응답에 같은 body를 쓴다.
            const resource = await this.nodes.readExtractResource(
              tx,
              applied.value.destinationId,
              req.destinationSegments,
            );
            response = {
              status: applied.value.status,
              body: {
                resource,
                affectedRevisions: applied.affectedRevisions,
                entryCount: read.length,
                createdCount: applied.value.createdCount,
                replacedCount: applied.value.replacedCount,
                ...(applied.value.trashId ? { trashId: applied.value.trashId } : {}),
              },
              headers: { 'x-request-id': requestId },
            };
            await this.receipts.complete(
              tx,
              identity,
              claim.generation,
              fingerprint,
              METHOD,
              response,
              body.length,
            );
          },
        );
        // commit이 끝났으므로 올린 object는 참조 중이다. 실패 정리 대상에서 뺀다.
        uploadedKeys.length = 0;
        return response!;
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof Error)
          error = controller.signal.reason;
        // 진행 중이던 stream과 업로드를 정착시킨 뒤에야 object를 정리한다.
        await source?.abort(error instanceof Error ? error : new Error('extract failed'));
        await this.cleanupUploads(uploadedKeys, error);
        return await storeErrorReceipt(this.receipts, owner, error, requestId);
      } finally {
        if (timeout) clearTimeout(timeout);
        responseSignal?.removeEventListener('abort', abortFromResponse);
        await lease?.stop();
        gateLease.release();
      }
    } catch (error) {
      await this.receipts.release(identity, claim.generation).catch(() => undefined);
      if (clientClosed) return { status: 499, body: null, headers: {} };
      throw error;
    }
  }

  /**
   * 올린 object를 정리한다. 확정 4xx이고 어떤 Blob도 참조하지 않을 때만 삭제한다.
   * 5xx·취소·불확정 commit·참조 확인 실패는 보존하고 GC에 맡긴다. 많은 key가 순차 삭제로 응답을 붙잡지 않도록
   * 제한된 병렬로 처리한다.
   */
  private async cleanupUploads(storageKeys: readonly string[], error: unknown): Promise<void> {
    for (let offset = 0; offset < storageKeys.length; offset += CLEANUP_CONCURRENCY) {
      await Promise.all(
        storageKeys
          .slice(offset, offset + CLEANUP_CONCURRENCY)
          .map((storageKey) => deleteUnreferencedUpload(this.blobs, this.storage, storageKey, error)),
      );
    }
  }

  /** capture한 size 경계 안의 range만 읽는다. 응답 길이가 요청과 다르면 저장소 이상으로 본다. */
  private rangeReader(capture: ExtractSourceCapture, openSource: (range?: BlobRange) => Promise<Readable>) {
    return async (start: bigint, length: number): Promise<Buffer> => {
      if (start < 0n || length < 0 || start + BigInt(length) > capture.source.size)
        throw new ExtractReaderError('format', 'range가 source 밖');
      if (length === 0) return Buffer.alloc(0);
      const stream = await openSource({ start: Number(start), end: Number(start) + length - 1 });
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of stream) chunks.push(chunk as Buffer);
      } finally {
        stream.destroy();
        await waitForClose(stream);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== length)
        throw new Error(`storage range 응답 길이 불일치: ${bytes.length} != ${length}`);
      return bytes;
    };
  }

  /** ZIP reader를 연다. 본문 stream은 entry마다 열리고 소비자가 소유한다. */
  private openZipPipeline(
    capture: ExtractSourceCapture,
    openSource: (range?: BlobRange) => Promise<Readable>,
    readRange: (start: bigint, length: number) => Promise<Buffer>,
    signal: AbortSignal,
  ): SourcePipeline {
    const entries = readZipEntries({
      size: capture.source.size,
      readRange,
      openRange: (start, length) => {
        if (length <= 0 || start < 0n || start + BigInt(length) > capture.source.size)
          throw new ExtractReaderError('format', 'range가 source 밖');
        return openSource({ start: Number(start), end: Number(start) + length - 1 });
      },
      signal,
    });
    return {
      entries,
      settled: async () => undefined,
      abort: async () => {
        await entries.return(undefined).catch(() => undefined);
      },
    };
  }

  /**
   * tar·tar.gz 순차 stream을 연다: raw GET → 길이 가드 → (압축 byte 계수 → gunzip → 압축비 검사) → reader.
   * 압축비는 제외 본문·확장 헤더·padding을 포함한 해제 출력 전체로 판정한다.
   * 마지막 stream(`out`)의 destroy가 상류를 모두 닫고 close를 기다린 뒤 gzip 오류를 번역한다.
   */
  private async openTarPipeline(
    format: ExtractFormat,
    capture: ExtractSourceCapture,
    openSource: (range?: BlobRange) => Promise<Readable>,
    signal: AbortSignal,
  ): Promise<SourcePipeline> {
    const raw = await openSource();
    const upstream: (Readable | Transform)[] = [raw, sourceLengthGuard(capture.source.size)];
    if (format === 'tar.gz') {
      const counts = { compressed: 0n, plain: 0n };
      const maxRatio = BigInt(this.extractConfig.maxRatio);
      upstream.push(
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            counts.compressed += BigInt(chunk.length);
            callback(null, chunk);
          },
        }),
        createGunzip(),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            counts.plain += BigInt(chunk.length);
            if (
              counts.plain >= RATIO_FLOOR &&
              counts.compressed > 0n &&
              counts.plain > counts.compressed * maxRatio
            )
              callback(new VfsExtractTooLargeError('ratio'));
            else callback(null, chunk);
          },
        }),
      );
    }
    const out = new PassThrough({
      destroy(error, callback) {
        for (const stage of upstream) if (!stage.destroyed) stage.destroy(error ?? undefined);
        void Promise.all(upstream.map(waitForClose)).then(() => callback(translateGzipError(error)));
      },
    });
    const done = new Promise<void>((resolve, reject) =>
      pipeline([...upstream, out], (error) => (error ? reject(error) : resolve())),
    );
    done.catch(() => undefined);
    const entries = readTarEntries(out, { maxHeaderBytes: MAX_TAR_HEADER_BYTES, signal });
    return {
      entries,
      // reader는 끝 블록 뒤 EOF까지 읽는다. EOF는 gzip trailer 검증 뒤에만 오므로 여기서는 종료만 기다린다.
      settled: async () => {
        out.resume();
        await done;
      },
      abort: async (error) => {
        await entries.return(undefined).catch(() => undefined);
        out.destroy(error);
        await waitForClose(out);
        await done.catch(() => undefined);
      },
    };
  }

  /** reader 오류를 공개 오류로 바꾼다. entryIndex는 호출자가 규칙대로 넘긴다. */
  private translate(error: unknown, entryIndex: number, fallbackName: string): unknown {
    if (!(error instanceof ExtractReaderError)) return error;
    if (error.kind === 'format') return new VfsExtractUnsupportedFormatError(error.reason);
    return new VfsExtractInvalidEntryError(entryIndex, error.entryName ?? fallbackName, error.reason);
  }

  /**
   * entry를 순회하며 planner→한도→본문 업로드(또는 dryRun hash)를 수행한다.
   *
   * 한도 순서: 선택 entry 수, FILE 해제 합(제외 FILE 포함), entry 하나 크기, ZIP 압축비다.
   * entryIndex 규칙은 다음과 같다.
   * - 현재 선택 entry 본문의 CRC·길이·DEFLATE 오류는 현재 순번이다.
   * - 다음 header·entry metadata 손상은 `planner.count`다. 이름을 읽기 전이면 빈 문자열이다.
   * - 제외 FILE을 drain하다 손상되면 다음 선택 순번과 제외 FILE 이름을 쓴다.
   */
  private async readEntries(
    format: ExtractFormat,
    req: ExtractRequest,
    entries: AsyncGenerator<ExtractSourceEntry>,
    maxFileBytes: number,
    encrypted: boolean,
    uploadedKeys: string[],
    signal: AbortSignal,
  ): Promise<ReadEntry[]> {
    const planner = new ExtractEntryPlanner({
      format,
      destinationSegments: req.destinationSegments,
      exclude: req.exclude,
      mimeTypes: req.mimeTypes,
    });
    const out: ReadEntry[] = [];
    let processedBytes = 0n;
    let lastExcludedName = '';
    const maxRatio = BigInt(this.extractConfig.maxRatio);

    for (;;) {
      let next: IteratorResult<ExtractSourceEntry>;
      try {
        next = await entries.next();
      } catch (error) {
        throw this.translate(error, planner.count, lastExcludedName);
      }
      if (next.done) return out;
      const entry = next.value;
      signal.throwIfAborted();
      lastExcludedName = '';
      const planned = planner.plan(entry.name, entry.type);
      if (entry.type === 'FILE') {
        // 제외 FILE의 처리 비용도 합계 한도에 넣는다. 선택 여부와 무관하다.
        processedBytes += entry.size;
        if (processedBytes > this.extractConfig.maxTotalBytes) throw new VfsExtractTooLargeError('bytes');
      }
      if (!planned) {
        // tar는 reader가 다음 next()에서 본문을 drain한다. zip은 본문을 열지 않는다.
        lastExcludedName = entry.name;
        continue;
      }
      if (planner.count > this.extractConfig.maxEntries) throw new VfsExtractTooLargeError('entries');
      if (planned.type === 'DIRECTORY') {
        out.push({
          planned,
          size: 0n,
          commit: {
            entryIndex: planned.entryIndex,
            name: entry.name,
            segments: planned.segments,
            type: 'DIRECTORY',
            blob: null,
          },
        });
        continue;
      }
      if (entry.size > BigInt(maxFileBytes)) throw new VfsExtractTooLargeError('entryBytes');
      if (
        entry.compressedSize !== null &&
        entry.size >= RATIO_FLOOR &&
        entry.size > entry.compressedSize * maxRatio
      )
        throw new VfsExtractTooLargeError('ratio');

      let blob: ExtractCommitEntry['blob'] = null;
      let stream: Readable | undefined;
      try {
        stream = await entry.open();
        // 선언 크기가 상한 이하임을 위에서 확인했으므로 cap은 선언 크기다. 실제 길이는 업로드 뒤 대조한다.
        const cap = Number(entry.size);
        if (req.dryRun) {
          const hashed = await this.ingress.hash(stream, cap);
          if (BigInt(hashed.size) !== entry.size)
            throw new VfsExtractInvalidEntryError(planned.entryIndex, entry.name, '평문 길이가 선언과 다름');
        } else {
          const storageKey = this.keys.generate();
          uploadedKeys.push(storageKey);
          const uploaded = await this.ingress.upload(
            storageKey,
            stream,
            planned.mimeType,
            cap,
            encrypted,
            signal,
          );
          if (BigInt(uploaded.size) !== entry.size)
            throw new VfsExtractInvalidEntryError(planned.entryIndex, entry.name, '평문 길이가 선언과 다름');
          blob = {
            storageKey,
            size: String(uploaded.size),
            mimeType: planned.mimeType,
            sha256: uploaded.sha256,
            encryptionIv: uploaded.encryptionIv,
          };
        }
      } catch (error) {
        throw this.translate(error, planned.entryIndex, entry.name);
      } finally {
        if (stream) {
          stream.destroy();
          await waitForClose(stream);
        }
      }
      out.push({
        planned,
        size: entry.size,
        commit: {
          entryIndex: planned.entryIndex,
          name: entry.name,
          segments: planned.segments,
          type: 'FILE',
          blob,
        },
      });
    }
  }
}

/**
 * source가 DB에 기록된 평문 크기와 같은 byte 수로 끝나는지 확인하는 Transform이다.
 * 짧은 응답을 gunzip이 gzip 손상으로 오분류하기 전에 일반 오류(5xx)로 실패시킨다.
 */
function sourceLengthGuard(expected: bigint): Transform {
  let seen = 0n;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += BigInt(chunk.length);
      if (seen > expected) callback(new Error('storage 응답이 source 크기를 넘음'));
      else callback(null, chunk);
    },
    flush(callback) {
      if (seen !== expected) callback(new Error(`storage 응답 길이 불일치: ${seen} != ${expected}`));
      else callback();
    },
  });
}

/** zlib 오류를 gzip 손상 entry 오류로 바꾼다. 이름을 알 수 없으므로 빈 문자열이다. 그 밖의 오류는 그대로 둔다. */
function translateGzipError(error: Error | null): Error | null {
  if (error === null) return null;
  if ((error as NodeJS.ErrnoException).code?.startsWith('Z_'))
    return new ExtractReaderError('entry', 'gzip 데이터 손상', '');
  return error;
}
