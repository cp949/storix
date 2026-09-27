import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CapabilityService } from '../capability/capability.service.js';
import { DomainError } from '../common/domain-error.js';
import { isUuid } from '../common/uuid.js';
import { resolveGlobalMaxFileSizeBytes, resolveMaxFileSizeBytes } from '../common/resource-limit.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import type { VfsUploadSessionEntity } from '../persistence/entities/vfs-upload-session.entity.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { toPreconditionCurrent } from './dto/node-response.dto.js';
import { parseUploadSessionCreateRequest } from './dto/upload-session-request.dto.js';
import { hashParts, identityOf, type MutationHttpResult } from './mutation.service.js';
import { PathResolver } from './path-resolver.js';
import { requireRootWithLimits } from './require-root.js';
import { encodeRevision } from './revision.js';
import { UPLOAD_SESSION_POLICY, type UploadSessionPolicy } from './upload-session-config.js';
import {
  VfsInvalidMutationRequestError, VfsIsDirectoryError, VfsNodeNotFoundError,
  VfsPreconditionFailedError, VfsNamespaceNotFoundError,
} from './vfs.errors.js';

class UploadSessionError extends DomainError {
  constructor(readonly code: string, readonly status: number, message: string,
    readonly retryAfterSeconds?: number) { super(message); }
}

function response(session: VfsUploadSessionEntity, creationReplay = false) {
  return {
    sessionId: session.id,
    state: creationReplay ? 'OPEN' : session.state,
    partSizeBytes: session.partSizeBytes,
    partCount: session.partCount,
    expiresAt: (creationReplay ? session.creationExpiresAt ?? session.expiresAt : session.expiresAt).toISOString(),
    maxExpiresAt: session.maxExpiresAt.toISOString(),
  };
}

@Injectable()
export class UploadSessionService {
  private readonly globalMaxFileSizeBytes: number;

  constructor(
    private readonly paths: PathResolver,
    private readonly nodes: VfsNodeRepository,
    private readonly sessions: VfsUploadSessionRepository,
    private readonly capabilities: CapabilityService,
    @Inject(UPLOAD_SESSION_POLICY) private readonly policy: UploadSessionPolicy | null,
    config: ConfigService,
  ) {
    this.globalMaxFileSizeBytes = resolveGlobalMaxFileSizeBytes(config.get<string>('STORIX_MAX_FILE_SIZE_BYTES'));
  }

  async create(namespaceId: string, scope: string | undefined, key: string | undefined,
    request: unknown, requestId: string): Promise<MutationHttpResult> {
    const identity = identityOf(namespaceId, scope, key);
    const { root, limits } = await requireRootWithLimits(this.nodes, namespaceId);
    const existing = await this.sessions.findByCreationKey(namespaceId, identity.scope, identity.key);
    if (!existing) this.capabilities.requireEnabled(namespaceId, 'resumable-upload');
    const parsed = parseUploadSessionCreateRequest(request);
    const resolved = this.paths.resolveConditional(parsed.path);
    if (resolved.segments.length === 0) throw new VfsInvalidMutationRequestError();
    const fingerprint = hashParts(['POST', 'upload-sessions', resolved.canonical,
      parsed.sizeBytes, parsed.mimeType, parsed.ifAbsent ? 'ABSENT' : parsed.ifRevision!]);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new UploadSessionError('MUTATION_KEY_REUSED', 409, '다른 요청에 사용한 mutation key');
      return { status: 201, body: response(existing, true), headers: { 'x-request-id': existing.requestId ?? requestId } };
    }
    const namespacePolicy = this.policy?.namespaces[namespaceId.toLowerCase()];
    if (!this.policy || !namespacePolicy) throw new UploadSessionError('VFS_FEATURE_DISABLED', 409, 'Upload session policy missing');
    const maxBytes = resolveMaxFileSizeBytes(limits.maxFileSizeBytes, this.globalMaxFileSizeBytes);
    const size = BigInt(parsed.sizeBytes);
    if (size > BigInt(maxBytes)) throw new VfsFileTooLargeError(maxBytes);
    const parentPath = resolved.segments.slice(0, -1);
    const parent = parentPath.length === 0 ? root : await this.nodes.resolvePath(namespaceId, root.id, parentPath);
    if (!parent || parent.type !== 'DIRECTORY')
      throw new VfsNodeNotFoundError(parentPath.length === 0 ? '/' : `/${parentPath.join('/')}`);
    const target = await this.nodes.resolvePath(namespaceId, root.id, resolved.segments);
    if (parsed.ifAbsent && target) throw new VfsPreconditionFailedError(resolved.canonical, toPreconditionCurrent(target, resolved.canonical));
    if (parsed.ifRevision) {
      if (!target) throw new VfsNodeNotFoundError(resolved.canonical);
      if (target.type === 'DIRECTORY') throw new VfsIsDirectoryError(resolved.canonical);
      if (encodeRevision(target) !== parsed.ifRevision)
        throw new VfsPreconditionFailedError(resolved.canonical, toPreconditionCurrent(target, resolved.canonical));
    }
    const partCount = Number((size + BigInt(this.policy.global.partSizeBytes) - 1n) /
      BigInt(this.policy.global.partSizeBytes));
    if (!Number.isSafeInteger(partCount) || partCount > 2147483647)
      throw new VfsFileTooLargeError(maxBytes);
    const now = new Date();
    const maxExpiresAt = new Date(now.getTime() + this.policy.global.maxLifetimeSeconds * 1000);
    const expiresAt = new Date(Math.min(now.getTime() + this.policy.global.inactivitySeconds * 1000,
      maxExpiresAt.getTime()));
    const outcome = await this.sessions.createSession({
      id: randomUUID(), namespaceId, scope: identity.scope, creationKey: identity.key,
      fingerprint, targetPath: resolved.canonical, sizeBytes: parsed.sizeBytes,
      mimeType: parsed.mimeType, conditionType: parsed.ifAbsent ? 'ABSENT' : 'REVISION',
      conditionRevision: parsed.ifRevision ?? null, partSizeBytes: this.policy.global.partSizeBytes,
      partCount, now, expiresAt, maxExpiresAt, requestId,
    }, { global: this.policy.global, namespace: namespacePolicy });
    if (outcome.kind === 'conflict') throw new UploadSessionError('MUTATION_KEY_REUSED', 409, '다른 요청에 사용한 mutation key');
    if (outcome.kind === 'limit') throw new UploadSessionError('VFS_UPLOAD_SESSION_LIMIT_EXCEEDED', 429,
      '활성 업로드 세션 상한 초과', 1);
    return { status: 201, body: response(outcome.session, true),
      headers: { 'x-request-id': outcome.session.requestId ?? requestId } };
  }

  async status(namespaceId: string, sessionId: string) {
    if (!isUuid(namespaceId)) throw new VfsNamespaceNotFoundError(namespaceId);
    if (!isUuid(sessionId)) throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const found = await this.sessions.findForStatus(namespaceId, sessionId);
    if (!found) throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const { session, parts } = found;
    return {
      ...response(session), path: session.targetPath, sizeBytes: String(session.sizeBytes),
      mimeType: session.mimeType,
      condition: session.conditionType === 'ABSENT'
        ? { ifAbsent: true } : { ifRevision: session.conditionRevision },
      parts: parts.map((part) => ({ index: part.partIndex, sizeBytes: String(part.sizeBytes) })),
      ...(session.state === 'COMPLETED' && session.responseBody
        ? { result: JSON.parse(session.responseBody) as unknown } : {}),
    };
  }

  async cancel(namespaceId: string, sessionId: string) {
    if (!isUuid(namespaceId)) throw new VfsNamespaceNotFoundError(namespaceId);
    if (!isUuid(sessionId)) throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const before = await this.sessions.findForStatus(namespaceId, sessionId);
    if (!before) throw new UploadSessionError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    if (before.session.state === 'OPEN') {
      const claimed = await this.sessions.claimTerminalTransition(namespaceId, sessionId, 'CANCELLED', new Date());
      if (claimed) return this.status(namespaceId, sessionId);
    }
    const current = await this.status(namespaceId, sessionId);
    if (current.state === 'CANCELLED') return current;
    throw new UploadSessionError('VFS_UPLOAD_SESSION_CLOSED', 409, '세션이 이미 종료되었음');
  }
}
