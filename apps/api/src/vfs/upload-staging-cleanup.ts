/**
 * staging DELETE 전 관측과 조건부 정산의 순서를 관리한다.
 * 실제 PUT 정착의 판단은 caller가 담당한다.
 * 규칙은 docs/design/07-resumable-upload.md "staging 정리 module".
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  VfsUploadSessionRepository,
  type UploadStagingAccountingResult,
} from '../persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';

/** 같은 조각 index의 새 예약과 구별하는 정리 대상이다. */
export interface UploadStagingTarget {
  /** 예약을 소유한 세션의 ID다. */
  readonly sessionId: string;

  /** 해당 세션 안의 조각 위치다. */
  readonly partIndex: number;

  /** 정리할 예약 세대의 key다. 새 세대의 key로 대체하지 않는다. */
  readonly stagingKey: string;
}

/** DELETE 확인과 DB 정산 적용·반환 바이트를 구분한다. DB 오류는 결과 대신 예외로 전달한다. */
export type UploadStagingCleanupResult =
  | {
      /** 해당 DELETE Promise의 성공 확인이다. 과금 반환을 뜻하지 않는다. */
      readonly kind: 'deleted';

      /** 정산 transaction의 변경 적용 여부다. deletedAt 기록만 적용해도 참이다. */
      readonly accountingRecorded: boolean;

      /** transaction에서 실제 반환한 바이트의 정확한 10진 문자열이다. */
      readonly refundedBytes: string;
    }
  | { readonly kind: 'delete-failed'; readonly error: unknown }
  | { readonly kind: 'skipped'; readonly reason: 'reservation-not-retired' | 'target-not-found' };

@Injectable()
export class UploadStagingCleanup {
  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly sessions: VfsUploadSessionRepository,
  ) {}

  /** 실제 PUT 정착 또는 PUT 미시작이 확인된 caller만 호출한다. */
  async cleanupSettledReservation(target: UploadStagingTarget): Promise<UploadStagingCleanupResult> {
    const deleted = await this.deleteObject(target.stagingKey);
    // DELETE 실패도 정착 기록과 재과금을 남겨야 GC가 안전하게 재시도할 수 있다.
    const accounting = await this.sessions.releasePartReservationDetailed(
      target.sessionId,
      target.partIndex,
      deleted.kind === 'delete-failed',
      target.stagingKey,
    );
    return deleted.kind === 'delete-failed' ? deleted : this.recorded(accounting);
  }

  /** 만료 예약을 retire한 뒤 삭제한다. abort는 진행 중 I/O의 취소가 아닌 다음 단계 시작 차단이다. */
  async cleanupExpiredReservation(
    target: UploadStagingTarget,
    signal?: AbortSignal,
  ): Promise<UploadStagingCleanupResult> {
    signal?.throwIfAborted();
    const retired = await this.sessions.retireExpiredPartReservation(
      target.sessionId,
      target.partIndex,
      target.stagingKey,
    );
    signal?.throwIfAborted();
    if (!retired) return { kind: 'skipped', reason: 'reservation-not-retired' };
    const deleted = await this.deleteObject(target.stagingKey);
    signal?.throwIfAborted();
    if (deleted.kind === 'delete-failed') return deleted;
    // 만료 예약 재시도는 PUT 정착을 입증하지 않는다.
    const accounting = await this.sessions.markTombstoneDeletedDetailed(target.stagingKey, null);
    signal?.throwIfAborted();
    return this.recorded(accounting);
  }

  /** 정확한 key의 정리 가능 state를 관측한 뒤 삭제한다. OPEN의 STORED 조각은 건너뛴다. */
  async cleanupStoredPart(target: UploadStagingTarget): Promise<UploadStagingCleanupResult> {
    const observed = await this.sessions.findCleanupPart(
      target.sessionId,
      target.partIndex,
      target.stagingKey,
    );
    if (!observed) return { kind: 'skipped', reason: 'target-not-found' };
    const deleted = await this.deleteObject(target.stagingKey);
    if (deleted.kind === 'delete-failed') return deleted;
    return this.recorded(
      await this.sessions.markStagingObjectDeletedDetailed(
        target.sessionId,
        target.partIndex,
        target.stagingKey,
        observed.state,
      ),
    );
  }

  /** DELETE 전에 관측한 정착 증거만 정산에 사용한다. */
  async cleanupTombstone(stagingKey: string): Promise<UploadStagingCleanupResult> {
    const observed = await this.sessions.findCleanupTombstone(stagingKey);
    if (!observed) return { kind: 'skipped', reason: 'target-not-found' };
    const deleted = await this.deleteObject(stagingKey);
    if (deleted.kind === 'delete-failed') return deleted;
    // DELETE 중의 늦은 PUT 정착은 다음 DELETE에서 관측한 뒤에만 반환 근거가 된다.
    return this.recorded(await this.sessions.markTombstoneDeletedDetailed(stagingKey, observed.putSettledAt));
  }

  private async deleteObject(
    stagingKey: string,
  ): Promise<{ kind: 'deleted' } | { kind: 'delete-failed'; error: unknown }> {
    try {
      await this.storage.delete(stagingKey);
      return { kind: 'deleted' };
    } catch (error) {
      return { kind: 'delete-failed', error };
    }
  }

  private recorded(accounting: UploadStagingAccountingResult): UploadStagingCleanupResult {
    return {
      kind: 'deleted',
      accountingRecorded: accounting.applied,
      refundedBytes: accounting.refundedBytes,
    };
  }
}
