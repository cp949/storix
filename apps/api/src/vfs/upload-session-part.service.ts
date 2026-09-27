import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { CapabilityService } from '../capability/capability.service.js';
import { DomainError } from '../common/domain-error.js';
import { parsePositiveInt } from '../common/env-parsing.js';
import { isUuid } from '../common/uuid.js';
import { EncryptingPutTarget } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import type { VfsUploadPartEntity } from '../persistence/entities/vfs-upload-part.entity.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { hashStream, uploadStream } from '../storage/stream-upload.js';
import { requireRootWithLimits } from './require-root.js';
import { UPLOAD_SESSION_POLICY, type UploadSessionPolicy } from './upload-session-config.js';
import { VfsNamespaceNotFoundError } from './vfs.errors.js';

class UploadPartError extends DomainError {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

export interface UploadedPartResult {
  readonly index: number;
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly replayed: boolean;
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
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
    config: ConfigService,
  ) {
    this.maxDurationMs = parsePositiveInt(config.get<string>('STORIX_MUTATION_MAX_UPLOAD_SECONDS'), 86400) * 1000;
  }

  async putPart(namespaceId: string, sessionId: string, rawIndex: string, source: Readable,
    contentLength: string | undefined, _requestId: string): Promise<UploadedPartResult> {
    if (!isUuid(namespaceId)) throw new VfsNamespaceNotFoundError(namespaceId);
    if (!isUuid(sessionId)) throw new UploadPartError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    if (!/^(0|[1-9][0-9]*)$/.test(rawIndex) || !Number.isSafeInteger(Number(rawIndex)))
      throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '유효하지 않은 조각 index');
    const index = Number(rawIndex);
    const found = await this.sessions.findForStatus(namespaceId, sessionId);
    if (!found) throw new UploadPartError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const { session } = found;
    if (index >= session.partCount) throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '조각 index 범위 초과');
    if (session.state !== 'OPEN' || session.expiresAt <= new Date() || session.maxExpiresAt <= new Date())
      throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료 또는 만료');
    this.capabilities.requireEnabled(namespaceId, 'resumable-upload');
    const namespacePolicy = this.policy?.namespaces[namespaceId.toLowerCase()];
    if (!this.policy || !namespacePolicy)
      throw new UploadPartError('VFS_FEATURE_DISABLED', 409, '업로드 세션 정책 없음');
    const expected = index === session.partCount - 1
      ? Number(BigInt(session.sizeBytes) - BigInt(index) * BigInt(session.partSizeBytes))
      : session.partSizeBytes;
    const existing = await this.sessions.findPart(sessionId, index);
    if (contentLength === undefined || !/^(0|[1-9][0-9]*)$/.test(contentLength) ||
      !Number.isSafeInteger(Number(contentLength)))
      throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '유효하지 않은 Content-Length');
    if (Number(contentLength) !== expected)
      throw existing?.state === 'STORED'
        ? new UploadPartError('VFS_UPLOAD_PART_CONFLICT', 409, '기존 조각과 크기 불일치')
        : new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '선언 조각 크기 불일치');
    const { limits } = await requireRootWithLimits(this.nodes, namespaceId);
    if (existing && existing.state === 'STORED')
      return this.replay(namespaceId, sessionId, source, expected, index, existing,
        this.policy.global.inactivitySeconds);
    if (existing && existing.state !== 'DELETED')
      throw new UploadPartError('VFS_UPLOAD_PART_IN_PROGRESS', 409, '조각 저장 또는 정리 진행 중');

    // 각 예약 시도마다 독립 UUID를 생성한다. 삭제된 행을 다시 사용해도 이전 key는 재사용하지 않는다.
    const stagingKey = `upload-staging/${randomUUID()}`;
    const reserved = await this.sessions.reservePart(sessionId, index, String(expected), stagingKey,
      { global: this.policy.global, namespace: namespacePolicy });
    if (reserved.kind === 'exists') {
      if (reserved.part.state === 'STORED')
        return this.replay(namespaceId, sessionId, source, expected, index, reserved.part,
          this.policy.global.inactivitySeconds);
      throw new UploadPartError('VFS_UPLOAD_PART_IN_PROGRESS', 409, '조각 저장 또는 정리 진행 중');
    }
    if (reserved.kind === 'limit') throw new UploadPartError('VFS_UPLOAD_STAGING_LIMIT_EXCEEDED', 413, '임시 저장량 상한 초과');
    if (reserved.kind === 'closed') throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료');
    if (reserved.kind !== 'reserved') throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '유효하지 않은 조각');

    const timer = this.durationTimer(source);
    let committed = false;
    try {
      const target = limits.encryptionPolicy === 'ENCRYPTED'
        ? new EncryptingPutTarget(this.storage, this.requireMasterKey()) : this.storage;
      const uploaded = await uploadStream(target, stagingKey, source, 'application/octet-stream', expected);
      if (uploaded.size !== expected)
        throw new UploadPartError('VFS_INVALID_UPLOAD_PART', 400, '실제 조각 크기 불일치');
      const encryptionIv = target instanceof EncryptingPutTarget ? target.getIv().toString('hex') : null;
      committed = await this.sessions.commitPart(sessionId, index, uploaded.sha256, encryptionIv,
        stagingKey, this.policy.global.inactivitySeconds);
      if (!committed) throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료');
      return { index, sizeBytes: String(expected), sha256: uploaded.sha256, replayed: false };
    } catch (error) {
      if (committed) throw error;
      // put 실패는 객체 생성 여부를 확정할 수 없다. 삭제 확인 전에는 예약 바이트를 유지한다.
      const deleted = await this.storage.delete(stagingKey).then(() => true, () => false);
      await this.sessions.releasePartReservation(sessionId, index, !deleted, stagingKey);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async replay(namespaceId: string, sessionId: string, source: Readable, expected: number,
    index: number, existing: VfsUploadPartEntity, inactivitySeconds: number): Promise<UploadedPartResult> {
    const timer = this.durationTimer(source);
    try {
      let hashed: Awaited<ReturnType<typeof hashStream>>;
      try {
        hashed = await hashStream(source, expected);
      } catch (error) {
        if (error instanceof VfsFileTooLargeError)
          throw new UploadPartError('VFS_UPLOAD_PART_CONFLICT', 409, '기존 조각과 크기 불일치');
        throw error;
      }
      if (hashed.size !== expected || hashed.sha256 !== existing.digest)
        throw new UploadPartError('VFS_UPLOAD_PART_CONFLICT', 409, '기존 조각과 내용 불일치');
      if (!(await this.sessions.renewSession(namespaceId, sessionId, new Date(), inactivitySeconds)))
        throw new UploadPartError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료 또는 만료');
      return { index, sizeBytes: String(expected), sha256: hashed.sha256, replayed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private durationTimer(source: Readable): NodeJS.Timeout {
    const timer = setTimeout(() => source.destroy(new Error('upload part duration exceeded')), this.maxDurationMs);
    timer.unref();
    return timer;
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) throw new Error('ENCRYPTED namespace master key missing');
    return this.masterKey;
  }
}
