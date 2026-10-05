import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CapabilityService } from '../capability/capability.service.js';
import { DomainError } from '../common/domain-error.js';
import { isNamespaceId } from '../common/namespace-id.js';
import { isUuid } from '../common/uuid.js';
import { resolveFileSizeLimits, resolveMaxFileSizeBytes } from '../common/resource-limit.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import type { VfsUploadSessionEntity } from '../persistence/entities/vfs-upload-session.entity.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { toPreconditionCurrent } from './dto/node-response.dto.js';
import { parseUploadSessionCreateRequest } from './dto/upload-session-request.dto.js';
import {
  assertExpirySeconds,
  parseExpirySeconds,
  type FileExpiryBounds,
  resolveFileExpiryBounds,
} from './file-expiry-policy.js';
import { hashParts, identityOf, type MutationHttpResult } from './mutation.service.js';
import { PathResolver } from './path-resolver.js';
import { requireRoot, requireRootWithLimits } from './require-root.js';
import { encodeRevision } from './revision.js';
import {
  resolveNamespaceUploadLimits,
  UPLOAD_SESSION_POLICY,
  type UploadSessionPolicy,
} from './upload-session-config.js';
import {
  VfsInvalidMutationRequestError,
  VfsInvalidExpiryError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsPreconditionFailedError,
  VfsNamespaceNotFoundError,
} from './vfs.errors.js';

class UploadSessionError extends DomainError {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

function response(session: VfsUploadSessionEntity, creationReplay = false) {
  return {
    sessionId: session.id,
    state: creationReplay ? 'OPEN' : session.state,
    partSizeBytes: session.partSizeBytes,
    partCount: session.partCount,
    expiresAt: (creationReplay
      ? (session.creationExpiresAt ?? session.expiresAt)
      : session.expiresAt
    ).toISOString(),
    maxExpiresAt: session.maxExpiresAt.toISOString(),
  };
}

function creationRequestId(session: VfsUploadSessionEntity, currentRequestId: string): string {
  if (session.creationRequestId !== null) return session.creationRequestId;
  // migration 이전에 완료된 행은 생성 ID가 유실됐으므로 이번 재시도의 ID를 사용한다.
  if (session.state === 'COMPLETED') return currentRequestId;
  return session.requestId ?? currentRequestId;
}

@Injectable()
export class UploadSessionService {
  private readonly globalMaxFileSizeBytes: number;
  private readonly defaultMaxFileSizeBytes: number;
  private readonly expiryBounds: FileExpiryBounds;

  constructor(
    private readonly paths: PathResolver,
    private readonly nodes: VfsNodeRepository,
    private readonly sessions: VfsUploadSessionRepository,
    private readonly capabilities: CapabilityService,
    @Inject(UPLOAD_SESSION_POLICY) private readonly policy: UploadSessionPolicy | null,
    config: ConfigService,
  ) {
    const fileSizeLimits = resolveFileSizeLimits(
      config.get<string>('STORIX_DEFAULT_FILE_SIZE_BYTES'),
      config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'),
    );
    this.globalMaxFileSizeBytes = fileSizeLimits.ceilingBytes;
    this.defaultMaxFileSizeBytes = fileSizeLimits.defaultBytes;
    this.expiryBounds = resolveFileExpiryBounds(
      config.get<string>('STORIX_VFS_EXPIRY_MIN_SECONDS'),
      config.get<string>('STORIX_VFS_EXPIRY_MAX_SECONDS'),
    );
  }

  async create(
    namespaceId: string,
    scope: string | undefined,
    key: string | undefined,
    request: unknown,
    requestId: string,
  ): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const { root, limits } = await requireRootWithLimits(this.nodes, namespaceId);
    const existing = await this.sessions.findByCreationKey(namespaceId, identity.scope, identity.key);
    if (!existing) this.capabilities.requireEnabled(namespaceId, 'resumable-upload');
    const parsed = parseUploadSessionCreateRequest(request);
    // 만료 초는 생성 때만 검증하며, 완료할 때는 세션에 고정된 값을 사용한다.
    let fileExpiresInSeconds: number | null = null;
    if (parsed.expiresInSeconds !== undefined) {
      if (!parsed.ifAbsent) throw new VfsInvalidExpiryError();
      fileExpiresInSeconds = parseExpirySeconds(parsed.expiresInSeconds);
    }
    const resolved = this.paths.resolveConditional(parsed.path);
    if (resolved.segments.length === 0) throw new VfsInvalidMutationRequestError();
    const fingerprint = hashParts([
      'POST',
      'upload-sessions',
      resolved.canonical,
      parsed.sizeBytes,
      parsed.mimeType,
      parsed.ifAbsent ? 'ABSENT' : parsed.ifRevision!,
      ...(parsed.sha256 === undefined ? [] : [parsed.sha256]),
      ...(fileExpiresInSeconds === null ? [] : [`expires:${fileExpiresInSeconds}`]),
    ]);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new UploadSessionError('MUTATION_KEY_REUSED', 409, '다른 요청에 사용한 mutation key');
      return {
        status: 201,
        body: response(existing, true),
        headers: { 'x-request-id': creationRequestId(existing, requestId) },
      };
    }
    if (fileExpiresInSeconds !== null) {
      fileExpiresInSeconds = assertExpirySeconds(fileExpiresInSeconds, this.expiryBounds);
    }
    if (!this.policy)
      throw new UploadSessionError('VFS_FEATURE_DISABLED', 409, 'Upload session policy missing');
    const namespacePolicy = resolveNamespaceUploadLimits(this.policy, namespaceId);
    const maxBytes = resolveMaxFileSizeBytes(
      limits.maxFileSizeBytes,
      this.globalMaxFileSizeBytes,
      this.defaultMaxFileSizeBytes,
    );
    const size = BigInt(parsed.sizeBytes);
    if (size > BigInt(maxBytes)) throw new VfsFileTooLargeError(maxBytes);
    // 완료 시점의 putConditionalContent와 같은 순서·오류로 판정한다.
    // 대상 조건(412·404) → 조상 경로(404·409 VFS_NOT_DIRECTORY) → DIRECTORY 대상(409) 순서다.
    const target = await this.nodes.resolvePath(namespaceId, root.id, resolved.segments);
    if (parsed.ifAbsent && target)
      throw new VfsPreconditionFailedError(
        resolved.canonical,
        toPreconditionCurrent(target, resolved.canonical),
      );
    if (parsed.ifRevision) {
      if (!target) throw new VfsNodeNotFoundError(resolved.canonical);
      if (encodeRevision(target) !== parsed.ifRevision)
        throw new VfsPreconditionFailedError(
          resolved.canonical,
          toPreconditionCurrent(target, resolved.canonical),
        );
    }
    await this.nodes.assertParentChain(namespaceId, root.id, resolved.segments);
    if (target?.type === 'DIRECTORY') throw new VfsIsDirectoryError(resolved.canonical);
    const partCount = Number(
      (size + BigInt(this.policy.global.partSizeBytes) - 1n) / BigInt(this.policy.global.partSizeBytes),
    );
    if (!Number.isSafeInteger(partCount) || partCount > 2147483647) throw new VfsFileTooLargeError(maxBytes);
    const now = new Date();
    const maxExpiresAt = new Date(now.getTime() + this.policy.global.maxLifetimeSeconds * 1000);
    const expiresAt = new Date(
      Math.min(now.getTime() + this.policy.global.inactivitySeconds * 1000, maxExpiresAt.getTime()),
    );
    const outcome = await this.sessions.createSession(
      {
        id: randomUUID(),
        namespaceId,
        scope: identity.scope,
        creationKey: identity.key,
        fingerprint,
        targetPath: resolved.canonical,
        sizeBytes: parsed.sizeBytes,
        sha256: parsed.sha256 ?? null,
        mimeType: parsed.mimeType,
        conditionType: parsed.ifAbsent ? 'ABSENT' : 'REVISION',
        conditionRevision: parsed.ifRevision ?? null,
        fileExpiresInSeconds,
        partSizeBytes: this.policy.global.partSizeBytes,
        partCount,
        now,
        expiresAt,
        maxExpiresAt,
        requestId,
      },
      { global: this.policy.global, namespace: namespacePolicy },
    );
    if (outcome.kind === 'conflict')
      throw new UploadSessionError('MUTATION_KEY_REUSED', 409, '다른 요청에 사용한 mutation key');
    if (outcome.kind === 'limit')
      throw new UploadSessionError('VFS_UPLOAD_SESSION_LIMIT_EXCEEDED', 429, '활성 업로드 세션 상한 초과', 1);
    return {
      status: 201,
      body: response(outcome.session, true),
      headers: { 'x-request-id': creationRequestId(outcome.session, requestId) },
    };
  }

  async status(namespaceId: string, rawSessionId: string) {
    if (!isNamespaceId(namespaceId)) throw new VfsNamespaceNotFoundError(namespaceId);
    await requireRoot(this.nodes, namespaceId);
    if (!isUuid(rawSessionId))
      throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    // 발급 ID는 소문자다. 대문자 입력은 DB 비교 방식과 무관하게 같은 세션으로 다룬다.
    const sessionId = rawSessionId.toLowerCase();
    const found = await this.sessions.findForStatus(namespaceId, sessionId);
    if (!found) throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const { session, parts } = found;
    return {
      ...response(session),
      path: session.targetPath,
      sizeBytes: String(session.sizeBytes),
      mimeType: session.mimeType,
      condition:
        session.conditionType === 'ABSENT'
          ? {
              ifAbsent: true,
              ...(session.fileExpiresInSeconds === null
                ? {}
                : { expiresInSeconds: session.fileExpiresInSeconds }),
            }
          : { ifRevision: session.conditionRevision },
      parts: parts.map((part) => ({ index: part.partIndex, sizeBytes: String(part.sizeBytes) })),
      ...(session.state === 'COMPLETED' && session.responseBody
        ? { result: JSON.parse(session.responseBody) as unknown }
        : {}),
      ...(session.state === 'FAILED' ? { failure: { code: 'VFS_CHECKSUM_MISMATCH' } } : {}),
    };
  }

  async cancel(namespaceId: string, rawSessionId: string) {
    if (!isNamespaceId(namespaceId)) throw new VfsNamespaceNotFoundError(namespaceId);
    await requireRoot(this.nodes, namespaceId);
    if (!isUuid(rawSessionId))
      throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    // 발급 ID는 소문자다. 대문자 입력은 DB 비교 방식과 무관하게 같은 세션으로 다룬다.
    const sessionId = rawSessionId.toLowerCase();
    const before = await this.sessions.findForStatus(namespaceId, sessionId);
    if (!before) throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const now = new Date();
    if (before.session.state === 'OPEN') {
      const { expiresAt, maxExpiresAt } = before.session;
      if (expiresAt <= now || maxExpiresAt <= now) {
        // GC가 아직 전환하지 않은 만료 세션도 조각 저장·완료와 같이 닫힌 세션으로 다룬다.
        // GC와 같은 EXPIRED 전환을 여기서 하고 아래에서 409로 거부한다.
        await this.sessions.claimTerminalTransition(namespaceId, sessionId, 'EXPIRED', now);
      } else if (await this.sessions.claimTerminalTransition(namespaceId, sessionId, 'CANCELLED', now)) {
        return this.status(namespaceId, sessionId);
      }
    }
    const current = await this.status(namespaceId, sessionId);
    if (current.state === 'CANCELLED') return current;
    throw new UploadSessionError('VFS_UPLOAD_SESSION_CLOSED', 409, '세션이 이미 종료되었음');
  }
}
