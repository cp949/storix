/**
 * DB에 저장된 phase에서 namespace 삭제를 재개하고 namespace별 실패를 격리한다.
 * 규칙은 docs/design/13-namespace-deletion.md "GC 단계". 결정은 api ADR-0032.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  NamespaceDeletionCleanupRepository,
  DataInconsistencyError,
} from '../persistence/namespace-deletion-cleanup.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import type { NamespaceDeletionEntity } from '../persistence/entities/namespace-deletion.entity.js';

/** 이번 실행에서 진행·완료·실패한 namespace 수다. */
export interface NamespaceDeletionRunResult {
  /** 다음 phase로 전환한 namespace 수다. */
  readonly advanced: number;

  /** DELETED로 전환한 namespace 수다. */
  readonly completed: number;

  /** 예외로 중단된 namespace 수다. */
  readonly failed: number;
}

/** 열린 삭제 operation 한 page의 처리 결과와 이어 읽을 위치다. */
export interface NamespaceDeletionPage extends NamespaceDeletionRunResult {
  /** 이번 호출이 읽은 operation 수. GC 단계 예산을 소모하는 단위다. */
  readonly examined: number;

  /** 이어 호출할 `after`(namespace ID). null이면 `after` 뒤에 열린 operation이 더 없다. */
  readonly next: string | null;
}

/** metadata 정리와 object 완료 판정을 기존 GC의 앞뒤에서 실행한다. */
@Injectable()
export class NamespaceDeletionCleanup {
  private readonly logger = new Logger(NamespaceDeletionCleanup.name);
  constructor(
    private readonly repository: NamespaceDeletionCleanupRepository,
    private readonly uploads: VfsUploadSessionRepository,
  ) {}

  private async visit(
    work: (op: NamespaceDeletionEntity) => Promise<{ advanced: number; completed: number }>,
    after: string | null,
    limit: number,
  ): Promise<NamespaceDeletionPage> {
    let advanced = 0,
      completed = 0,
      failed = 0;
    const operations = await this.repository.listOpenOperations(limit, after ?? undefined);
    for (const op of operations) {
      try {
        const result = await work(op);
        advanced += result.advanced;
        completed += result.completed;
      } catch (error) {
        failed++;
        this.logger.error(`namespace 삭제 정리 실패: ${op.namespaceId}`, error);
        if (error instanceof DataInconsistencyError) {
          try {
            await this.repository.setBlocked(op.namespaceId, 'DATA_INCONSISTENT');
          } catch (recordError) {
            this.logger.error(`namespace 삭제 보류 기록 실패: ${op.namespaceId}`, recordError);
          }
        }
      }
    }
    return {
      advanced,
      completed,
      failed,
      examined: operations.length,
      next: operations.length < limit ? null : operations[operations.length - 1].namespaceId,
    };
  }

  /**
   * OPEN session을 취소하고 live·snapshot·trash metadata를 배치로 제거한다. `after` 뒤의 열린 operation을
   * 최대 `limit`개 처리한다. 한 operation의 metadata 제거는 끝까지 진행한다.
   */
  async advance(now: Date, after: string | null = null, limit = 100): Promise<NamespaceDeletionPage> {
    return this.visit(
      async (op) => {
        let advanced = false;
        if (op.phase === 'UPLOADS') {
          for (const id of await this.uploads.findOpenSessionIds(op.namespaceId))
            await this.uploads.claimTerminalTransition(op.namespaceId, id, 'CANCELLED', now);
          if (await this.uploads.countLiveSessions(op.namespaceId)) return { advanced: 0, completed: 0 };
          advanced = await this.repository.setPhase(op.namespaceId, 'UPLOADS', 'METADATA');
          op.phase = 'METADATA';
        }
        if (op.phase === 'METADATA') {
          await this.repository.removeChangeFeed(op.namespaceId);
          while (await this.repository.removeLeafNodes(op.namespaceId, 500)) {
            /* 배치별 커밋 뒤 재조회한다. */
          }
          while (await this.repository.removeOneSnapshot(op.namespaceId)) {
            /* manifest 단위로 정산한다. */
          }
          while (await this.repository.removeOneTrash(op.namespaceId)) {
            /* manifest 단위로 정산한다. */
          }
          await this.repository.removeMutationReceipts(op.namespaceId);
          await this.uploads.deleteSettledSessions(op.namespaceId);
          if (
            Object.values(await this.repository.countRemainingMetadata(op.namespaceId)).every(
              (count) => count === 0,
            )
          )
            advanced = (await this.repository.setPhase(op.namespaceId, 'METADATA', 'OBJECTS')) || advanced;
        }
        return { advanced: Number(advanced), completed: 0 };
      },
      after,
      limit,
    );
  }

  /**
   * 기존 GC의 object 삭제 뒤 grace·tombstone·session·counter를 확인한다.
   *
   * `orphanBlobsExhausted`는 이번 실행의 orphan-blobs 단계가 예산 소진으로 멈췄다는 뜻이다.
   * 이때 grace가 지난 Blob은 삭제에 실패한 것이 아니라 아직 처리하지 못한 것일 수 있다.
   * 실패로 단정하지 않고 `blockedReason`을 설정하지도 지우지도 않는다. 다음 실행이 다시 판정한다.
   */
  async settle(
    cutoff: Date,
    now: Date,
    after: string | null = null,
    limit = 100,
    orphanBlobsExhausted = false,
  ): Promise<NamespaceDeletionPage> {
    return this.visit(
      async (op) => {
        const unchanged = { advanced: 0, completed: 0 };
        if (op.phase !== 'OBJECTS') return unchanged;
        await this.uploads.deleteSettledSessions(op.namespaceId);
        const objects = await this.repository.inspectObjects(op.namespaceId, cutoff);
        if (objects.referenced) throw new DataInconsistencyError('참조 중 Blob이 남았다');
        if (objects.overdue) {
          if (!orphanBlobsExhausted)
            await this.repository.setBlocked(op.namespaceId, 'STORAGE_DELETE_FAILED');
          return unchanged;
        }
        if (objects.pending) {
          await this.repository.setBlocked(op.namespaceId, null);
          return unchanged;
        }
        const tombstones = await this.uploads.countTombstones(op.namespaceId);
        // 사유를 먼저 null로 지우지 않는다. 지속되는 보류가 매 GC마다 상태 조회에서 잠시 사라지기 때문이다.
        if (tombstones.unsettled) {
          await this.repository.setBlocked(op.namespaceId, 'UPLOAD_SETTLEMENT_UNKNOWN');
          return unchanged;
        }
        await this.repository.setBlocked(op.namespaceId, null);
        if (tombstones.total || (await this.uploads.countSessions(op.namespaceId))) return unchanged;
        const counters = await this.repository.readCounters(op.namespaceId);
        const usage = await this.uploads.readNamespaceUsage(op.namespaceId);
        if ([...Object.values(counters), ...Object.values(usage)].some((value) => BigInt(value) !== 0n))
          throw new DataInconsistencyError('정산 후 counter가 남았다');
        return { advanced: 0, completed: Number(await this.repository.complete(op.namespaceId, now)) };
      },
      after,
      limit,
    );
  }
}
