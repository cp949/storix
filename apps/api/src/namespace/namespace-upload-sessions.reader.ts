// namespace 단건 조회에 합성할 재개 업로드 정책·사용량을 읽는다.
// 규칙은 docs/design/07-resumable-upload.md "설정과 만료".
import { Inject, Injectable } from '@nestjs/common';
import { CapabilityService } from '../capability/capability.service.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import {
  resolveNamespaceUploadLimits,
  resolveNamespaceUploadPartSize,
  UPLOAD_SESSION_POLICY,
  type UploadSessionPolicy,
} from '../vfs/upload-session-config.js';

/** `GET /api/v2/namespaces/{id}` 응답의 `uploadSessions` 블록. 바이트 한도·사용량은 int64 문자열이다. */
export interface NamespaceUploadSessionsDto {
  /** 새 세션에 적용할 조각 크기. namespace 값이 있으면 그 값, 없으면 전역 값. */
  partSizeBytes: number;

  /** 전역 값. namespace override가 없다. */
  inactivitySeconds: number;

  /** 전역 값. namespace override가 없다. */
  maxLifetimeSeconds: number;

  /** namespace 값, 없으면 전역 값. */
  maxStagedBytes: string;

  /** namespace 값, 없으면 전역 값. */
  maxActiveSessions: number;

  /** 예약과 정착을 구분하지 않은 staging 사용량. 호출 시점 읽기다. */
  stagedBytes: string;

  /** 진행 중인 세션 수. 호출 시점 읽기다. */
  activeSessions: number;
}

/**
 * namespace의 재개 업로드 정책과 사용량을 `uploadSessions` 블록으로 만든다.
 * 정확한 admission 판정이 아니므로 블록을 읽은 뒤에도 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`가 날 수 있다.
 *
 * 규칙은 docs/design/07-resumable-upload.md "설정과 만료".
 */
@Injectable()
export class NamespaceUploadSessionsReader {
  constructor(
    private readonly capabilities: CapabilityService,
    @Inject(UPLOAD_SESSION_POLICY) private readonly policy: UploadSessionPolicy | null,
    private readonly sessions: VfsUploadSessionRepository,
  ) {}

  /**
   * 블록을 돌려준다. 다음 중 하나면 `null`이고 사용량은 읽지 않는다.
   * - namespace가 `ACTIVE`가 아니다.
   * - `resumable-upload`가 비활성이다.
   * - 업로드 세션 정책이 없다.
   */
  async read(namespaceId: string, status: string): Promise<NamespaceUploadSessionsDto | null> {
    if (status !== 'ACTIVE' || !this.policy) return null;
    if (!this.capabilities.isEnabled(namespaceId, 'resumable-upload')) return null;
    const limits = resolveNamespaceUploadLimits(this.policy, namespaceId);
    const usage = await this.sessions.readNamespaceUsage(namespaceId);
    return {
      partSizeBytes: resolveNamespaceUploadPartSize(this.policy, namespaceId),
      inactivitySeconds: this.policy.global.inactivitySeconds,
      maxLifetimeSeconds: this.policy.global.maxLifetimeSeconds,
      maxStagedBytes: limits.maxStagedBytes.toString(),
      maxActiveSessions: limits.maxActiveSessions,
      stagedBytes: usage.stagedBytes,
      activeSessions: Number(usage.activeSessions),
    };
  }
}
