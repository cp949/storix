import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DomainError } from '../common/domain-error.js';
import { isUuid } from '../common/uuid.js';
import { EncryptingPutTarget, getEncrypted } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import type { VfsUploadPartEntity } from '../persistence/entities/vfs-upload-part.entity.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { uploadStream } from '../storage/stream-upload.js';
import type { MutationHttpResult } from './mutation.service.js';
import { PathResolver } from './path-resolver.js';
import { requireRootWithLimits } from './require-root.js';
import { VfsNamespaceNotFoundError } from './vfs.errors.js';

class UploadFinalizeError extends DomainError {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LEASE_MS = 60 * 60 * 1000;

@Injectable()
export class UploadSessionFinalizeService {
  constructor(
    private readonly paths: PathResolver,
    private readonly nodes: VfsNodeRepository,
    private readonly sessions: VfsUploadSessionRepository,
    private readonly keys: StorageKeyGenerator,
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
  ) {}

  async complete(namespaceId: string, sessionId: string, requestId: string): Promise<MutationHttpResult> {
    if (!isUuid(namespaceId)) throw new VfsNamespaceNotFoundError(namespaceId);
    if (!isUuid(sessionId))
      throw new UploadFinalizeError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    const claim = await this.sessions.claimFinalize(namespaceId, sessionId, LEASE_MS);
    if (claim.kind === 'not-found')
      throw new UploadFinalizeError('VFS_UPLOAD_SESSION_NOT_FOUND', 404, '업로드 세션 없음');
    if (claim.kind === 'incomplete')
      throw new UploadFinalizeError('VFS_UPLOAD_PARTS_INCOMPLETE', 409, '저장되지 않은 조각 있음');
    if (claim.kind === 'busy')
      throw new UploadFinalizeError('VFS_UPLOAD_SESSION_IN_PROGRESS', 409, '업로드 완료 진행 중');
    if (claim.kind === 'closed')
      throw new UploadFinalizeError('VFS_UPLOAD_SESSION_CLOSED', 409, '업로드 세션 종료');
    if (claim.kind === 'complete') return this.replay(claim.session);

    const { session, parts, token } = claim;
    const storageKey = this.keys.generate();
    try {
      const { root, limits } = await requireRootWithLimits(this.nodes, namespaceId);
      const encrypted = limits.encryptionPolicy === 'ENCRYPTED';
      const target = encrypted
        ? new EncryptingPutTarget(this.storage, this.requireMasterKey())
        : this.storage;
      const source = Readable.from(this.readParts(parts, encrypted));
      const lease = this.startLeaseRenewal(namespaceId, sessionId, token, source);
      let uploaded: Awaited<ReturnType<typeof uploadStream>>;
      try {
        uploaded = await uploadStream(
          target,
          storageKey,
          source,
          session.mimeType,
          Number(session.sizeBytes),
        );
      } catch (error) {
        if (lease.lost) throw new Error('Upload finalize claim lost');
        throw error;
      } finally {
        await lease.stop();
      }
      if (
        lease.lost ||
        !(await this.sessions.renewFinalize(
          namespaceId,
          sessionId,
          token,
          new Date(),
          new Date(Date.now() + LEASE_MS),
        ))
      )
        throw new Error('Upload finalize claim lost');
      if (BigInt(uploaded.size) !== BigInt(session.sizeBytes)) throw new Error('Final upload size mismatch');
      const resolved = this.paths.resolveConditional(session.targetPath);
      const condition =
        session.conditionType === 'ABSENT'
          ? { ifAbsent: true as const }
          : { ifRevision: session.conditionRevision! };
      const applied = await this.nodes.withMutation(
        namespaceId,
        root.id,
        async (tx) => {
          await this.sessions.fenceFinalize(
            tx.manager,
            namespaceId,
            sessionId,
            token,
            new Date(),
            new Date(Date.now() + LEASE_MS),
          );
          return this.nodes.putConditionalContent(tx, resolved.segments, condition, {
            storageKey,
            size: String(uploaded.size),
            mimeType: session.mimeType,
            sha256: uploaded.sha256,
            encryptionIv: target instanceof EncryptingPutTarget ? target.getIv() : null,
          });
        },
        (tx, result) =>
          this.sessions.completeFinalize(
            tx.manager,
            namespaceId,
            sessionId,
            token,
            result.value.status,
            JSON.stringify({ resource: result.value.resource, affectedRevisions: result.affectedRevisions }),
            requestId,
          ),
      );
      return {
        status: applied.value.status,
        body: { resource: applied.value.resource, affectedRevisions: applied.affectedRevisions },
        headers: { 'x-request-id': requestId },
      };
    } catch (error) {
      // commit 결과가 불명확한 DB 장애에서 참조된 객체를 지우면 공개 파일이 손실된다.
      const referenced = await this.sessions.isFinalObjectReferenced(storageKey).catch(() => true);
      if (!referenced) await this.storage.delete(storageKey).catch(() => undefined);
      await this.sessions.releaseFinalize(namespaceId, sessionId, token).catch(() => undefined);
      throw error;
    }
  }

  private replay(session: {
    responseStatus: number | null;
    responseBody: string | null;
    requestId: string | null;
  }): MutationHttpResult {
    if (session.responseStatus === null || session.responseBody === null || session.requestId === null)
      throw new Error('Completed upload session has no response');
    return {
      status: session.responseStatus,
      body: JSON.parse(session.responseBody) as unknown,
      headers: { 'x-request-id': session.requestId },
    };
  }

  private async *readParts(parts: VfsUploadPartEntity[], encrypted: boolean): AsyncGenerator<Buffer> {
    for (const part of parts) {
      const stream = encrypted
        ? await getEncrypted(
            this.storage,
            part.stagingKey,
            Buffer.from(part.encryptionIv!, 'hex'),
            this.requireMasterKey(),
          )
        : await this.storage.get(part.stagingKey);
      const hash = createHash('sha256');
      let size = 0n;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += BigInt(chunk.length);
        if (size > BigInt(part.sizeBytes)) throw new Error('Staging part size mismatch');
        hash.update(chunk);
        yield chunk;
      }
      if (size !== BigInt(part.sizeBytes) || hash.digest('hex') !== part.digest)
        throw new Error('Staging part integrity mismatch');
    }
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) throw new Error('ENCRYPTED namespace master key missing');
    return this.masterKey;
  }

  private startLeaseRenewal(namespaceId: string, sessionId: string, token: string, source: Readable) {
    let lost = false;
    let renewal: Promise<void> | null = null;
    const timer = setInterval(
      () => {
        if (renewal || lost) return;
        const now = new Date();
        renewal = this.sessions
          .renewFinalize(namespaceId, sessionId, token, now, new Date(now.getTime() + LEASE_MS))
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            if (lost) source.destroy();
            renewal = null;
          });
      },
      Math.max(250, Math.floor(LEASE_MS / 3)),
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
