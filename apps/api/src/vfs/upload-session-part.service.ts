import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { CapabilityService } from '../capability/capability.service.js';
import { DomainError } from '../common/domain-error.js';
import { parseMaxUploadSeconds } from '../common/upload-duration.js';
import { isNamespaceId } from '../common/namespace-id.js';
import { isUuid } from '../common/uuid.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import type { VfsUploadPartEntity } from '../persistence/entities/vfs-upload-part.entity.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { UPLOAD_STAGING_KEY_PREFIX } from '../storage/storage-key-prefixes.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { requireRoot, requireRootWithLimits } from './require-root.js';
import {
  resolveNamespaceUploadLimits,
  UPLOAD_SESSION_POLICY,
  type UploadSessionPolicy,
} from './upload-session-config.js';
import { parseSha256Header } from './sha256-header.js';
import { VfsNamespaceNotFoundError, VfsPartChecksumMismatchError } from './vfs.errors.js';
import { ContentIngressService } from './content-ingress.service.js';
import { UploadSessionStagingFileTooLargeError } from './upload-session-file-size.policy.js';

class UploadPartError extends DomainError {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface UploadedPartResult {
  readonly index: number;
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly replayed: boolean;
  /** 이 요청이 갱신한 뒤의 세션 비활동 만료 시각(ISO). `maxExpiresAt`을 넘지 않는다. */
  readonly expiresAt: string;
}

@Injectable()
export class UploadSessionPartService {
  private readonly maxDurationMs: number;

  constructor(
    private readonly nodes: VfsNodeRepository,
    private readonly sessions: VfsUploadSessionRepository,
    private readonly capabilities: CapabilityService,
    @Inject(UPLOAD_SESSION_POLICY) private readonly policy: UploadSessionPolicy | null,
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly contentIngress: ContentIngressService,
    config: ConfigService,
  ) {
    this.maxDurationMs =
      parseMaxUploadSeconds(config.get<string>('STORIX_MUTATION_MAX_UPLOAD_SECONDS')) * 1000;
  }

  async putPart(
    namespaceId: string,
    rawSessionId: string,
    rawIndex: string,
    source: Readable,
    contentLength: string | undefined,
    _requestId: string,
    rawExpectedSha256?: string,
  ): Promise<UploadedPartResult> {
    // 형식 오류는 세션 조회와 본문 소비 전에 400으로 거부한다.
    const expectedSha256 = parseSha256Header(rawExpectedSha256);
    if (!isNamespaceId(namespaceId)) throw new VfsNamespaceNotFoundError(namespaceId);
    await requireRoot(this.nodes, namespaceId);
    if (!isUuid(rawSessionId))
      throw new UploadPartError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    // 발급 ID는 소문자다. 대문자 입력은 DB 비교 방식과 무관하게 같은 세션으로 다룬다.
    const sessionId = rawSessionId.toLowerCase();
    if (!/^(0|[1-9][0-9]*)$/.test(rawIndex) || !Number.isSafeInteger(Number(rawIndex)))
      throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '유효하지 않은 조각 index');
    const index = Number(rawIndex);
    const found = await this.sessions.findForStatus(namespaceId, sessionId);
    if (!found) throw new UploadPartError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const { session } = found;
    if (index >= session.partCount)
      throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '조각 index 범위 초과');
    if (session.state !== 'OPEN' || session.expiresAt <= new Date() || session.maxExpiresAt <= new Date())
      throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료 또는 만료');
    this.capabilities.requireEnabled(namespaceId, 'resumable-upload');
    if (!this.policy) throw new UploadPartError('VFS_FEATURE_DISABLED', 409, '업로드 세션 정책 없음');
    const namespacePolicy = resolveNamespaceUploadLimits(this.policy, namespaceId);
    const expected =
      index === session.partCount - 1
        ? Number(BigInt(session.sizeBytes) - BigInt(index) * BigInt(session.partSizeBytes))
        : session.partSizeBytes;
    const existing = await this.sessions.findPart(sessionId, index);
    if (
      contentLength === undefined ||
      !/^(0|[1-9][0-9]*)$/.test(contentLength) ||
      !Number.isSafeInteger(Number(contentLength))
    )
      throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '유효하지 않은 Content-Length');
    if (Number(contentLength) !== expected)
      throw existing?.state === 'STORED'
        ? new UploadPartError('VFS_UPLOAD_PART_CONFLICT', 409, '기존 조각과 크기 불일치')
        : new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '선언 조각 크기 불일치');
    const { limits } = await requireRootWithLimits(this.nodes, namespaceId);
    if (existing && existing.state === 'STORED')
      return this.replay(
        namespaceId,
        sessionId,
        source,
        expected,
        index,
        existing,
        this.policy.global.inactivitySeconds,
        expectedSha256,
      );

    const deadline = this.durationDeadline(source);
    let reserved: Awaited<ReturnType<VfsUploadSessionRepository['reservePart']>>;
    try {
      if (
        existing?.state === 'RESERVED' &&
        (!existing.leaseExpiresAt || existing.leaseExpiresAt <= new Date())
      ) {
        const retired = await Promise.race([
          this.sessions.retireExpiredPartReservation(sessionId, index, existing.stagingKey),
          deadline.promise,
        ]);
        if (!retired)
          throw new UploadPartError('VFS_UPLOAD_PART_IN_PROGRESS', 409, '조각 저장 또는 정리 진행 중');
        await Promise.race([this.storage.delete(existing.stagingKey), deadline.promise]);
        await Promise.race([this.sessions.markTombstoneDeleted(existing.stagingKey, null), deadline.promise]);
      } else if (existing && existing.state !== 'DELETED') {
        throw new UploadPartError('VFS_UPLOAD_PART_IN_PROGRESS', 409, '조각 저장 또는 정리 진행 중');
      }

      // 각 예약 시도마다 독립 UUID를 생성한다. 삭제된 행을 다시 사용해도 이전 key는 재사용하지 않는다.
      const stagingKey = `${UPLOAD_STAGING_KEY_PREFIX}${randomUUID()}`;
      const reservation = this.sessions.reservePart(sessionId, index, String(expected), stagingKey, {
        global: this.policy.global,
        namespace: namespacePolicy,
      });
      try {
        reserved = await Promise.race([reservation, deadline.promise]);
      } catch (error) {
        if (deadline.expired()) {
          // DB 예약이 응답 이후 커밋되더라도 PUT는 시작하지 않았으므로 안전하게 되돌린다.
          void reservation
            .then((result) =>
              result.kind === 'reserved'
                ? this.sessions.releasePartReservation(sessionId, index, false, stagingKey)
                : false,
            )
            .catch(() => false);
        }
        throw error;
      }
    } catch (error) {
      clearTimeout(deadline.timer);
      throw error;
    }
    if (reserved.kind === 'exists') {
      clearTimeout(deadline.timer);
      if (reserved.part.state === 'STORED')
        return this.replay(
          namespaceId,
          sessionId,
          source,
          expected,
          index,
          reserved.part,
          this.policy.global.inactivitySeconds,
          expectedSha256,
        );
      throw new UploadPartError('VFS_UPLOAD_PART_IN_PROGRESS', 409, '조각 저장 또는 정리 진행 중');
    }
    if (reserved.kind === 'in-progress') {
      clearTimeout(deadline.timer);
      throw new UploadPartError('VFS_UPLOAD_PART_IN_PROGRESS', 409, '조각 저장 또는 정리 진행 중');
    }
    if (reserved.kind === 'limit') {
      clearTimeout(deadline.timer);
      throw new UploadPartError('VFS_UPLOAD_STAGING_LIMIT_EXCEEDED', 413, '임시 저장량 상한 초과');
    }
    if (reserved.kind === 'file-too-large') {
      clearTimeout(deadline.timer);
      const maxStagedBytes =
        this.policy.global.maxStagedBytes < namespacePolicy.maxStagedBytes
          ? this.policy.global.maxStagedBytes
          : namespacePolicy.maxStagedBytes;
      throw new UploadSessionStagingFileTooLargeError(BigInt(session.sizeBytes), maxStagedBytes);
    }
    if (reserved.kind === 'closed') {
      clearTimeout(deadline.timer);
      throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료');
    }
    if (reserved.kind !== 'reserved') {
      clearTimeout(deadline.timer);
      throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '유효하지 않은 조각');
    }
    const stagingKey = reserved.part.stagingKey;
    const heartbeat = setInterval(() => {
      void this.sessions
        .renewPartLease(sessionId, index, stagingKey)
        .then((renewed) => {
          if (!renewed) source.destroy(new Error('upload part lease lost'));
        })
        .catch(() => source.destroy(new Error('upload part lease renewal failed')));
    }, 20_000);
    heartbeat.unref();
    let lateCleanup = false;
    let uploadSettled = false;
    let committed: { expiresAt: Date } | null = null;
    let commitAttempted = false;
    let commitResolved = false;
    try {
      const upload = this.contentIngress
        .upload(
          stagingKey,
          source,
          'application/octet-stream',
          expected,
          limits.encryptionPolicy === 'ENCRYPTED',
        )
        .finally(() => {
          uploadSettled = true;
        });
      let uploaded: Awaited<typeof upload>;
      try {
        uploaded = await Promise.race([upload, deadline.promise]);
      } catch (error) {
        if (deadline.expired() && !uploadSettled) {
          // 스토리지 PUT는 취소·종료 보장이 없다. HTTP deadline 후에도 소유 lease와
          // 예약 과금을 유지하고 실제 PUT가 끝난 뒤 key별로 정리한다.
          lateCleanup = true;
          void upload
            .then(
              () => this.cleanupReservation(sessionId, index, stagingKey),
              () => this.cleanupReservation(sessionId, index, stagingKey),
            )
            .finally(() => clearInterval(heartbeat))
            .catch(() => undefined);
        }
        throw error;
      }
      if (uploaded.size !== expected)
        throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '실제 조각 크기 불일치');
      // 헤더와 다르면 저장하지 않는다. 아래 catch가 staging 객체를 지우고 예약을 해제한다.
      if (expectedSha256 !== undefined && uploaded.sha256 !== expectedSha256)
        throw new VfsPartChecksumMismatchError();
      const encryptionIv = uploaded.encryptionIv?.toString('hex') ?? null;
      commitAttempted = true;
      committed = await Promise.race([
        this.sessions
          .commitPart(
            sessionId,
            index,
            uploaded.sha256,
            encryptionIv,
            stagingKey,
            this.policy.global.inactivitySeconds,
          )
          .then((result) => {
            commitResolved = true;
            return result;
          }),
        deadline.promise,
      ]);
      if (!committed) throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료');
      return {
        index,
        sizeBytes: String(expected),
        sha256: uploaded.sha256,
        replayed: false,
        expiresAt: committed.expiresAt.toISOString(),
      };
    } catch (error) {
      if (committed) throw error;
      if (lateCleanup) throw error;
      if (commitAttempted && !commitResolved) {
        // ACK 유실 또는 deadline이면 DB 판정이 불확실하다. 빠른 조회에서 commit을
        // 확인하면 성공으로 복구하고, deadline을 넘기면 객체·과금을 보존해 백그라운드로 넘긴다.
        const reconcile = async () => {
          try {
            const persisted = await this.sessions.findPart(sessionId, index);
            if (persisted?.state === 'STORED' && persisted.stagingKey === stagingKey && persisted.digest)
              return persisted;
            await this.sessions.releasePartReservation(sessionId, index, true, stagingKey);
          } catch {
            // 판정할 수 없으면 lease 만료 뒤 GC가 예약을 tombstone으로 옮긴다.
          }
          return null;
        };
        if (deadline.expired()) {
          lateCleanup = true;
          void reconcile()
            .finally(() => clearInterval(heartbeat))
            .catch(() => undefined);
          throw error;
        }
        try {
          // ACK를 잃었어도 저장이 확정됐으면 성공으로 복구한다. 만료 시각은 이 조회가 읽은 값이라
          // 다른 PUT이 그 사이 갱신했다면 이 요청의 갱신값보다 늦을 수 있다.
          const persisted = await Promise.race([
            this.sessions.findStoredPartWithExpiry(sessionId, index, stagingKey),
            deadline.promise,
          ]);
          if (persisted?.part.digest)
            return {
              index,
              sizeBytes: String(expected),
              sha256: persisted.part.digest,
              replayed: false,
              expiresAt: persisted.expiresAt.toISOString(),
            };
          await Promise.race([
            this.sessions.releasePartReservation(sessionId, index, true, stagingKey),
            deadline.promise,
          ]);
        } catch (recoveryError) {
          lateCleanup = true;
          void reconcile()
            .finally(() => clearInterval(heartbeat))
            .catch(() => undefined);
          throw deadline.expired() ? recoveryError : error;
        }
        throw error;
      }
      // cleanup DELETE도 제한 시간 안에서 기다린다. 시간 초과 시 PUT/DELETE 완료까지
      // lease와 과금을 유지하고 늦은 정리 callback에 맡긴다.
      const cleanup = this.cleanupReservation(sessionId, index, stagingKey);
      try {
        await Promise.race([cleanup, deadline.promise]);
      } catch (cleanupError) {
        if (deadline.expired()) {
          lateCleanup = true;
          void cleanup.finally(() => clearInterval(heartbeat)).catch(() => undefined);
          throw cleanupError;
        }
        throw cleanupError;
      }
      throw error;
    } finally {
      clearTimeout(deadline.timer);
      if (!lateCleanup) clearInterval(heartbeat);
    }
  }

  private async replay(
    namespaceId: string,
    sessionId: string,
    source: Readable,
    expected: number,
    index: number,
    existing: VfsUploadPartEntity,
    inactivitySeconds: number,
    expectedSha256: string | undefined,
  ): Promise<UploadedPartResult> {
    const deadline = this.durationDeadline(source);
    try {
      let hashed: Awaited<ReturnType<ContentIngressService['hash']>>;
      try {
        hashed = await Promise.race([this.contentIngress.hash(source, expected), deadline.promise]);
      } catch (error) {
        if (error instanceof VfsFileTooLargeError)
          throw new UploadPartError('VFS_UPLOAD_PART_CONFLICT', 409, '기존 조각과 크기 불일치');
        throw error;
      }
      // 판정 순서: 헤더 ≠ 본문 해시(422)가 저장된 조각과의 비교(409)보다 먼저다.
      if (expectedSha256 !== undefined && hashed.sha256 !== expectedSha256)
        throw new VfsPartChecksumMismatchError();
      if (hashed.size !== expected || hashed.sha256 !== existing.digest)
        throw new UploadPartError('VFS_UPLOAD_PART_CONFLICT', 409, '기존 조각과 내용 불일치');
      const renewed = await Promise.race([
        this.sessions.renewSession(namespaceId, sessionId, new Date(), inactivitySeconds),
        deadline.promise,
      ]);
      if (!renewed) throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료 또는 만료');
      return {
        index,
        sizeBytes: String(expected),
        sha256: hashed.sha256,
        replayed: true,
        expiresAt: renewed.expiresAt.toISOString(),
      };
    } finally {
      clearTimeout(deadline.timer);
    }
  }

  private durationDeadline(source: Readable): {
    timer: NodeJS.Timeout;
    promise: Promise<never>;
    expired: () => boolean;
  } {
    let expired = false;
    let timer!: NodeJS.Timeout;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        const error = new Error('upload part duration exceeded');
        source.destroy(error);
        reject(error);
      }, this.maxDurationMs);
    });
    timer.unref();
    return { timer, promise, expired: () => expired };
  }

  private async cleanupReservation(sessionId: string, index: number, key: string): Promise<void> {
    const deleted = await this.storage.delete(key).then(
      () => true,
      () => false,
    );
    await this.sessions.releasePartReservation(sessionId, index, !deleted, key);
  }
}
