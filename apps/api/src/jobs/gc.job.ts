import {
  NamespaceDeletionCleanup,
  type NamespaceDeletionPage,
  type NamespaceDeletionRunResult,
} from './namespace-deletion.cleanup.js';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePositiveInt } from '../common/env-parsing.js';
import { BlobRepository, type OrphanBlobCursor } from '../persistence/blob.repository.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import {
  type ChangeFeedPruneCursor,
  VfsChangeFeedRetentionRepository,
  resolveChangeFeedRetentionDays,
} from '../persistence/vfs-change-feed-retention.repository.js';
import { GcCursorRepository } from '../persistence/gc-cursor.repository.js';
import {
  IDEMPOTENCY_RECEIPT_RETENTION_DAYS,
  IdempotencyReceiptRetentionRepository,
} from '../persistence/idempotency-receipt-retention.repository.js';
import { DEFAULT_GC_STAGE_BUDGET } from './gc-budget.js';
import { type GcStageContext, runBudgetedStage, runCursorStage } from './gc-stage.js';
import { VfsTrashRetentionRepository } from '../persistence/vfs-trash-retention.repository.js';
import { type FileExpiryCursor, VfsFileExpiryRepository } from '../persistence/vfs-file-expiry.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';

const DELETE_CONCURRENCY = 20;
const CLEANUP_BATCH_SIZE = 500;
const CHANGE_FEED_PRUNE_CURSOR = 'change-feed-prune';
const ORPHAN_BLOBS_CURSOR = 'orphan-blobs';
const NAMESPACE_DELETION_PAGE_SIZE = 100;
const ORPHAN_OBJECT_PAGE_SIZE = 1000;
const ORPHAN_BLOB_PAGE_SIZE = 500;

export interface GcResult {
  /** 다음 정리 phase로 진행한 namespace 수다. */
  readonly advancedNamespaceDeletions: number;

  /** 이번 실행에서 DELETED로 전환한 namespace 수다. */
  readonly completedNamespaceDeletions: number;

  /** 삭제 정리 중 예외가 발생한 namespace 수다. */
  readonly failedNamespaceDeletions: number;
  readonly deletedOrphanObjects: number;
  readonly deletedOrphanBlobs: number;
  readonly prunedMutationReceipts: number;

  /** 보존 기간을 넘겨 지운 namespace 생성·관리 receipt(`idempotency_key`) 수다. */
  readonly prunedIdempotencyReceipts: number;
  readonly expiredUploadSessions: number;
  readonly recoveredUploadSessions: number;
  readonly deletedStagingObjects: number;
  readonly prunedUploadSessions: number;
  readonly prunedChangeEvents: number;
  readonly prunedTrashItems: number;
  readonly prunedTrashBytes: string;
  readonly expiredFiles: number;
  readonly expiredBytes: string;

  /** 단계 예산이 소진돼 남은 작업을 다음 실행으로 넘긴 단계 이름이다. */
  readonly budgetExhaustedStages: readonly string[];
}

@Injectable()
export class GcJob {
  private readonly logger = new Logger(GcJob.name);
  private readonly gracePeriodSeconds: number;
  private readonly changeRetentionDays: number;
  private readonly stageBudgetLimit: number;

  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly blobRepository: BlobRepository,
    config: ConfigService,
    @Optional() private readonly receiptRepository?: VfsMutationReceiptRepository,
    @Optional() private readonly uploadSessions?: VfsUploadSessionRepository,
    @Optional() private readonly changeFeedRetention?: VfsChangeFeedRetentionRepository,
    @Optional() private readonly trashRetention?: VfsTrashRetentionRepository,
    @Optional() private readonly fileExpiry?: VfsFileExpiryRepository,
    @Optional() private readonly namespaceDeletion?: NamespaceDeletionCleanup,
    @Optional() private readonly gcCursors?: GcCursorRepository,
    @Optional() private readonly idempotencyReceipts?: IdempotencyReceiptRetentionRepository,
  ) {
    this.gracePeriodSeconds = parsePositiveInt(config.get<string>('STORIX_ORPHAN_GRACE_PERIOD'), 86400);
    this.stageBudgetLimit = parsePositiveInt(
      config.get<string>('STORIX_GC_MAX_ROWS_PER_STAGE'),
      DEFAULT_GC_STAGE_BUDGET,
    );
    this.changeRetentionDays = resolveChangeFeedRetentionDays(
      config.get<string>('STORIX_VFS_CHANGE_RETENTION_DAYS'),
    );
  }

  async run(): Promise<GcResult> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.gracePeriodSeconds * 1000);
    const exhausted: string[] = [];

    const recoveredUploadSessions = await this.recoverStaleFinalizingLeases(now, exhausted);
    const advanced = await this.visitNamespaceDeletions('namespace-deletion-advance', exhausted, (after) =>
      this.namespaceDeletion!.advance(now, after, NAMESPACE_DELETION_PAGE_SIZE),
    );
    const expiredUploadSessions = await this.expireOpenSessions(now, exhausted);
    const deletedStagingObjects = await this.cleanStagingObjects(now, exhausted);

    // 만료 삭제 뒤 참조가 0이 된 Blob은 orphan grace 이후 회수한다.
    const expired = await this.expireFiles(exhausted);
    const deletedOrphanObjects = await this.collectOrphanObjects(cutoff, exhausted);
    const deletedOrphanBlobs = await this.collectOrphanBlobs(cutoff, exhausted);
    const settled = await this.visitNamespaceDeletions('namespace-deletion-settle', exhausted, (after) =>
      this.namespaceDeletion!.settle(cutoff, now, after, NAMESPACE_DELETION_PAGE_SIZE),
    );
    const prunedMutationReceipts = await this.pruneReceipts(exhausted);
    const prunedIdempotencyReceipts = await this.pruneIdempotencyReceipts(exhausted);
    const prunedUploadSessions = await this.pruneTerminalSessions(now, exhausted);
    const prunedChangeEvents = await this.pruneChangeFeed(exhausted);
    const trash = await this.pruneTrash(exhausted);

    this.logger.log(
      `GC 완료: orphan object ${deletedOrphanObjects}건, orphan blob ${deletedOrphanBlobs}건 삭제`,
    );
    return {
      advancedNamespaceDeletions: advanced.advanced,
      completedNamespaceDeletions: settled.completed,
      failedNamespaceDeletions: advanced.failed + settled.failed,
      deletedOrphanObjects,
      deletedOrphanBlobs,
      prunedMutationReceipts,
      prunedIdempotencyReceipts,
      expiredUploadSessions,
      recoveredUploadSessions,
      deletedStagingObjects,
      prunedUploadSessions,
      prunedChangeEvents,
      prunedTrashItems: trash.items,
      prunedTrashBytes: trash.bytes,
      expiredFiles: expired.files,
      expiredBytes: expired.bytes,
      budgetExhaustedStages: exhausted,
    };
  }

  private async recoverStaleFinalizingLeases(now: Date, exhausted: string[]): Promise<number> {
    const uploads = this.uploadSessions;
    if (!uploads) return 0;
    let recovered = 0;
    await runBudgetedStage(this.stageContext, 'stale-finalizing-lease-recovery', exhausted, async () => {
      const count = await uploads.recoverStaleFinalizingLeases(now, CLEANUP_BATCH_SIZE);
      recovered += count;
      return { done: count < CLEANUP_BATCH_SIZE, examined: count };
    });
    return recovered;
  }

  // namespace 삭제 operation을 page 단위로 이어 돌린다. 결과는 합산한다.
  private async visitNamespaceDeletions(
    stage: string,
    exhausted: string[],
    visit: (after: string | null) => Promise<NamespaceDeletionPage>,
  ): Promise<NamespaceDeletionRunResult> {
    const total = { advanced: 0, completed: 0, failed: 0 };
    if (!this.namespaceDeletion) return total;
    await runCursorStage<string>(
      this.stageContext,
      stage,
      exhausted,
      (raw) => (typeof raw === 'string' ? raw : null),
      async (after) => {
        const page = await visit(after);
        total.advanced += page.advanced;
        total.completed += page.completed;
        total.failed += page.failed;
        return { next: page.next, examined: page.examined };
      },
    );
    return total;
  }

  private async expireOpenSessions(now: Date, exhausted: string[]): Promise<number> {
    const uploads = this.uploadSessions;
    if (!uploads) return 0;
    let expired = 0;
    await runCursorStage<{ expiresAt: string; id: string }>(
      this.stageContext,
      'expired-upload-sessions',
      exhausted,
      (raw) => {
        const value = raw as { expiresAt?: unknown; id?: unknown } | null;
        return value !== null && typeof value.expiresAt === 'string' && typeof value.id === 'string'
          ? { expiresAt: value.expiresAt, id: value.id }
          : null;
      },
      async (after) => {
        const sessions = await uploads.findExpiredOpenSessions(now, CLEANUP_BATCH_SIZE, after);
        for (const session of sessions) {
          if (await uploads.claimTerminalTransition(session.namespaceId, session.id, 'EXPIRED', now))
            expired++;
        }
        const last = sessions[sessions.length - 1];
        return {
          next:
            sessions.length < CLEANUP_BATCH_SIZE
              ? null
              : { expiresAt: last.expiresAt.toISOString(), id: last.id },
          examined: sessions.length,
        };
      },
    );
    return expired;
  }

  // staging object 정리 3단계: 만료된 예약 회수, 정리 대상 part, 오래된 tombstone.
  private async cleanStagingObjects(now: Date, exhausted: string[]): Promise<number> {
    const uploads = this.uploadSessions;
    if (!uploads) return 0;
    let deleted = 0;
    const parsePart = (raw: unknown): { sessionId: string; partIndex: number } | null => {
      const value = raw as { sessionId?: unknown; partIndex?: unknown } | null;
      return value !== null && typeof value.sessionId === 'string' && typeof value.partIndex === 'number'
        ? { sessionId: value.sessionId, partIndex: value.partIndex }
        : null;
    };
    await runCursorStage<{ sessionId: string; partIndex: number }>(
      this.stageContext,
      'staging-reserved-parts',
      exhausted,
      parsePart,
      async (after) => {
        const stale = await uploads.findExpiredReservedParts(now, after, CLEANUP_BATCH_SIZE);
        for (const part of stale) {
          await uploads.retireExpiredPartReservation(part.sessionId, part.partIndex, part.stagingKey, now);
        }
        const last = stale[stale.length - 1];
        return {
          next:
            stale.length < CLEANUP_BATCH_SIZE
              ? null
              : { sessionId: last.sessionId, partIndex: last.partIndex },
          examined: stale.length,
        };
      },
    );
    await runCursorStage<{ sessionId: string; partIndex: number }>(
      this.stageContext,
      'staging-cleanup-parts',
      exhausted,
      parsePart,
      async (after) => {
        const parts = await uploads.findCleanupParts(after, CLEANUP_BATCH_SIZE);
        for (const part of parts) {
          try {
            await this.storage.delete(part.stagingKey);
            if (
              await uploads.markStagingObjectDeleted(
                part.sessionId,
                part.partIndex,
                part.stagingKey,
                part.state,
              )
            )
              deleted++;
          } catch (error) {
            this.logger.error(`staging object 삭제 실패: ${part.stagingKey}`, error);
          }
        }
        const last = parts[parts.length - 1];
        return {
          next:
            parts.length < CLEANUP_BATCH_SIZE
              ? null
              : { sessionId: last.sessionId, partIndex: last.partIndex },
          examined: parts.length,
        };
      },
    );
    await runCursorStage<string>(
      this.stageContext,
      'staging-tombstones',
      exhausted,
      (raw) => (typeof raw === 'string' ? raw : null),
      async (after) => {
        const old = await uploads.findCleanupTombstones(after, CLEANUP_BATCH_SIZE);
        for (const part of old) {
          try {
            await this.storage.delete(part.stagingKey);
            // The observed PUT settlement belongs to this delete attempt. A PUT
            // settling while delete is in flight needs another delete before refund.
            if (await uploads.markTombstoneDeleted(part.stagingKey, part.putSettledAt)) deleted++;
          } catch (error) {
            this.logger.error(`stale staging object 삭제 실패: ${part.stagingKey}`, error);
          }
        }
        return {
          next: old.length < CLEANUP_BATCH_SIZE ? null : old[old.length - 1].stagingKey,
          examined: old.length,
        };
      },
    );
    return deleted;
  }

  private async expireFiles(exhausted: string[]): Promise<{ files: number; bytes: string }> {
    const expiry = this.fileExpiry;
    if (!expiry) return { files: 0, bytes: '0' };
    let files = 0;
    let bytes = 0n;
    await runCursorStage<FileExpiryCursor>(
      this.stageContext,
      'file-expiry',
      exhausted,
      (raw) => {
        const value = raw as Partial<FileExpiryCursor> | null;
        return value !== null && typeof value.expiresAt === 'string' && typeof value.id === 'string'
          ? { expiresAt: value.expiresAt, id: value.id }
          : null;
      },
      async (after) => {
        const batch = await expiry.expireDue(CLEANUP_BATCH_SIZE, after);
        files += batch.files;
        bytes += BigInt(batch.bytes);
        return { next: batch.next, examined: batch.examined };
      },
    );
    return { files, bytes: bytes.toString() };
  }

  private async pruneReceipts(exhausted: string[]): Promise<number> {
    const receipts = this.receiptRepository;
    if (!receipts) return 0;
    let pruned = 0;
    await runBudgetedStage(this.stageContext, 'mutation-receipt-prune', exhausted, async () => {
      const count = await receipts.pruneExpired(new Date());
      pruned += count;
      return { done: count < CLEANUP_BATCH_SIZE, examined: count };
    });
    return pruned;
  }

  private async pruneIdempotencyReceipts(exhausted: string[]): Promise<number> {
    const receipts = this.idempotencyReceipts;
    if (!receipts) return 0;
    let pruned = 0;
    await runBudgetedStage(this.stageContext, 'idempotency-receipt-prune', exhausted, async () => {
      const count = await receipts.pruneExpiredBatch(IDEMPOTENCY_RECEIPT_RETENTION_DAYS, CLEANUP_BATCH_SIZE);
      pruned += count;
      return { done: count < CLEANUP_BATCH_SIZE, examined: count };
    });
    return pruned;
  }

  private async pruneTerminalSessions(now: Date, exhausted: string[]): Promise<number> {
    const uploads = this.uploadSessions;
    if (!uploads) return 0;
    const before = new Date(now.getTime() - 30 * 24 * 3600_000);
    let pruned = 0;
    await runBudgetedStage(this.stageContext, 'upload-session-prune', exhausted, async () => {
      const count = await uploads.pruneTerminalSessions(before, CLEANUP_BATCH_SIZE);
      pruned += count;
      return { done: count < CLEANUP_BATCH_SIZE, examined: count };
    });
    return pruned;
  }

  private async pruneTrash(exhausted: string[]): Promise<{ items: number; bytes: string }> {
    const trash = this.trashRetention;
    if (!trash) return { items: 0, bytes: '0' };
    let items = 0;
    let bytes = 0n;
    await runBudgetedStage(this.stageContext, 'trash-prune', exhausted, async () => {
      const batch = await trash.pruneExpiredBatch(CLEANUP_BATCH_SIZE);
      items += batch.items;
      bytes += BigInt(batch.bytes);
      return { done: batch.items === 0, examined: batch.items };
    });
    return { items, bytes: bytes.toString() };
  }

  private get stageContext(): GcStageContext {
    return { budgetLimit: this.stageBudgetLimit, cursors: this.gcCursors, logger: this.logger };
  }

  private async pruneChangeFeed(exhaustedStages: string[]): Promise<number> {
    const retention = this.changeFeedRetention;
    if (!retention) return 0;
    let pruned = 0;
    await runCursorStage<ChangeFeedPruneCursor>(
      this.stageContext,
      CHANGE_FEED_PRUNE_CURSOR,
      exhaustedStages,
      (raw) => {
        const value = raw as Partial<ChangeFeedPruneCursor> | null;
        return value !== null &&
          typeof value === 'object' &&
          typeof value.occurredAt === 'string' &&
          typeof value.namespaceId === 'string' &&
          typeof value.sequence === 'string'
          ? { occurredAt: value.occurredAt, namespaceId: value.namespaceId, sequence: value.sequence }
          : null;
      },
      async (cursor) => {
        const result = await retention.pruneNext(this.changeRetentionDays, CLEANUP_BATCH_SIZE, cursor);
        pruned += result.deleted;
        return { next: result.next, examined: result.examined };
      },
    );
    return pruned;
  }

  // metadata 없는 스토리지 object: 'blobs/'·'upload-staging/' prefix를 key 오름차순으로 한 page씩 읽고
  // page의 key만 DB 인덱스로 대조한다. 전체 key 집합과 삭제 대상 목록을 메모리에 모으지 않는다.
  // storage key에는 namespace 정보가 없어 namespace 단위로 좁힐 수 없다. prefix로 스캔 범위를 좁혀
  // STORIX_STORAGE_BUCKET에 Storix가 만들지 않은 object가 섞여 있어도 삭제 대상에서 제외한다
  // (StorageKeyGenerator.generate() 참고: 모든 key는 `blobs/{shard}/{uuid}` 형식).
  private async collectOrphanObjects(cutoff: Date, exhaustedStages: string[]): Promise<number> {
    let deleted = await this.collectOrphanObjectsUnder(
      'blobs/',
      'orphan-objects-blobs',
      cutoff,
      exhaustedStages,
      (keys) => this.blobRepository.findKnownStorageKeys(keys),
    );
    const uploads = this.uploadSessions;
    if (uploads) {
      deleted += await this.collectOrphanObjectsUnder(
        'upload-staging/',
        'orphan-objects-staging',
        cutoff,
        exhaustedStages,
        (keys) => uploads.findKnownStagingKeys(keys),
      );
    }
    return deleted;
  }

  private async collectOrphanObjectsUnder(
    prefix: string,
    stage: string,
    cutoff: Date,
    exhaustedStages: string[],
    findKnown: (keys: readonly string[]) => Promise<Set<string>>,
  ): Promise<number> {
    let deleted = 0;
    await runCursorStage<string>(
      this.stageContext,
      stage,
      exhaustedStages,
      (raw) => (typeof raw === 'string' ? raw : null),
      async (startAfter) => {
        const page = await this.storage.listPage(prefix, {
          startAfter: startAfter ?? undefined,
          limit: ORPHAN_OBJECT_PAGE_SIZE,
        });
        const candidates = page.items.filter((item) => item.lastModified < cutoff).map((item) => item.key);
        const known = candidates.length === 0 ? new Set<string>() : await findKnown(candidates);
        deleted += await this.deleteKeysInChunks(candidates.filter((key) => !known.has(key)));
        return { next: page.nextAfter, examined: page.items.length };
      },
    );
    return deleted;
  }

  // reference_count=0인 Blob: 후보를 (zero_since, id) keyset으로 한 page씩 읽는다. 스토리지 object 삭제가
  // 끝난 뒤 성공한 것만 metadata row를 삭제한다. 실패한 행은 남아 다음 실행에서 다시 후보가 된다.
  // Postgres row lock을 스토리지 I/O 동안 들고 있지 않기 위해 후보 조회에는 FOR UPDATE를 쓰지 않는다.
  private async collectOrphanBlobs(cutoff: Date, exhaustedStages: string[]): Promise<number> {
    let deleted = 0;
    await runCursorStage<OrphanBlobCursor>(
      this.stageContext,
      ORPHAN_BLOBS_CURSOR,
      exhaustedStages,
      (raw) => {
        const value = raw as Partial<OrphanBlobCursor> | null;
        return value !== null &&
          typeof value === 'object' &&
          typeof value.zeroSince === 'string' &&
          typeof value.id === 'string'
          ? { zeroSince: value.zeroSince, id: value.id }
          : null;
      },
      async (cursor) => {
        const orphans = await this.blobRepository.findOrphanBlobsPage(cutoff, cursor, ORPHAN_BLOB_PAGE_SIZE);
        const deletedIds: string[] = [];
        for (let i = 0; i < orphans.length; i += DELETE_CONCURRENCY) {
          const chunk = orphans.slice(i, i + DELETE_CONCURRENCY);
          const results = await Promise.allSettled(chunk.map((blob) => this.storage.delete(blob.storageKey)));
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              deletedIds.push(chunk[index].id);
            } else {
              this.logger.error(`orphan blob object 삭제 실패: ${chunk[index].id}`, result.reason);
            }
          });
        }
        await this.blobRepository.deleteBlobRows(deletedIds);
        deleted += deletedIds.length;
        const last = orphans[orphans.length - 1];
        return {
          next: orphans.length < ORPHAN_BLOB_PAGE_SIZE ? null : { zeroSince: last.zeroSince, id: last.id },
          examined: orphans.length,
        };
      },
    );
    return deleted;
  }

  private async deleteKeysInChunks(keys: string[]): Promise<number> {
    let deletedCount = 0;
    for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
      const chunk = keys.slice(i, i + DELETE_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((key) => this.storage.delete(key)));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          deletedCount += 1;
        } else {
          this.logger.error(`orphan object 삭제 실패: ${chunk[index]}`, result.reason);
        }
      });
    }
    return deletedCount;
  }
}
