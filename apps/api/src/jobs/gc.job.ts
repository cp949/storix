import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePositiveInt } from '../common/env-parsing.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import {
  VfsChangeFeedRetentionRepository,
  resolveChangeFeedRetentionDays,
} from '../persistence/vfs-change-feed-retention.repository.js';
import { VfsTrashRetentionRepository } from '../persistence/vfs-trash-retention.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';

const DELETE_CONCURRENCY = 20;
const CLEANUP_BATCH_SIZE = 500;

export interface GcResult {
  readonly deletedOrphanObjects: number;
  readonly deletedOrphanBlobs: number;
  readonly prunedMutationReceipts: number;
  readonly expiredUploadSessions: number;
  readonly recoveredUploadSessions: number;
  readonly deletedStagingObjects: number;
  readonly prunedUploadSessions: number;
  readonly prunedChangeEvents: number;
  readonly prunedTrashItems: number;
  readonly prunedTrashBytes: string;
}

@Injectable()
export class GcJob {
  private readonly logger = new Logger(GcJob.name);
  private readonly gracePeriodSeconds: number;
  private readonly changeRetentionDays: number;

  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly blobRepository: BlobRepository,
    config: ConfigService,
    @Optional() private readonly receiptRepository?: VfsMutationReceiptRepository,
    @Optional() private readonly uploadSessions?: VfsUploadSessionRepository,
    @Optional() private readonly changeFeedRetention?: VfsChangeFeedRetentionRepository,
    @Optional() private readonly trashRetention?: VfsTrashRetentionRepository,
  ) {
    this.gracePeriodSeconds = parsePositiveInt(config.get<string>('STORIX_ORPHAN_GRACE_PERIOD'), 86400);
    this.changeRetentionDays = resolveChangeFeedRetentionDays(
      config.get<string>('STORIX_VFS_CHANGE_RETENTION_DAYS'),
    );
  }

  async run(): Promise<GcResult> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.gracePeriodSeconds * 1000);

    const recoveredUploadSessions = (await this.uploadSessions?.recoverStaleFinalizingLeases(now)) ?? 0;
    let expiredUploadSessions = 0;
    for (const session of (await this.uploadSessions?.findExpiredOpenSessions(now)) ?? []) {
      if (await this.uploadSessions!.claimTerminalTransition(session.namespaceId, session.id, 'EXPIRED', now))
        expiredUploadSessions++;
    }
    let deletedStagingObjects = 0;
    if (this.uploadSessions) {
      let staleAfter: { sessionId: string; partIndex: number } | null = null;
      while (true) {
        const stale = await this.uploadSessions.findExpiredReservedParts(now, staleAfter, CLEANUP_BATCH_SIZE);
        for (const part of stale) {
          await this.uploadSessions.retireExpiredPartReservation(
            part.sessionId,
            part.partIndex,
            part.stagingKey,
            now,
          );
        }
        if (stale.length < CLEANUP_BATCH_SIZE) break;
        const last = stale[stale.length - 1];
        staleAfter = { sessionId: last.sessionId, partIndex: last.partIndex };
      }
      let after: { sessionId: string; partIndex: number } | null = null;
      while (true) {
        const parts = await this.uploadSessions.findCleanupParts(after, CLEANUP_BATCH_SIZE);
        for (const part of parts) {
          try {
            await this.storage.delete(part.stagingKey);
            if (
              await this.uploadSessions.markStagingObjectDeleted(
                part.sessionId,
                part.partIndex,
                part.stagingKey,
                part.state,
              )
            )
              deletedStagingObjects++;
          } catch (error) {
            this.logger.error(`staging object 삭제 실패: ${part.stagingKey}`, error);
          }
        }
        if (parts.length < CLEANUP_BATCH_SIZE) break;
        const last = parts[parts.length - 1];
        after = { sessionId: last.sessionId, partIndex: last.partIndex };
      }
      let tombstoneAfter: string | null = null;
      while (true) {
        const old = await this.uploadSessions.findCleanupTombstones(tombstoneAfter, CLEANUP_BATCH_SIZE);
        for (const part of old) {
          try {
            await this.storage.delete(part.stagingKey);
            // The observed PUT settlement belongs to this delete attempt. A PUT
            // settling while delete is in flight needs another delete before refund.
            if (await this.uploadSessions.markTombstoneDeleted(part.stagingKey, part.putSettledAt))
              deletedStagingObjects++;
          } catch (error) {
            this.logger.error(`stale staging object 삭제 실패: ${part.stagingKey}`, error);
          }
        }
        if (old.length < CLEANUP_BATCH_SIZE) break;
        tombstoneAfter = old[old.length - 1].stagingKey;
      }
    }

    const deletedOrphanObjects = await this.collectOrphanObjects(cutoff);
    const deletedOrphanBlobs = await this.collectOrphanBlobs(cutoff);
    const prunedMutationReceipts = (await this.receiptRepository?.pruneExpired(new Date())) ?? 0;
    const prunedUploadSessions =
      (await this.uploadSessions?.pruneTerminalSessions(new Date(now.getTime() - 30 * 24 * 3600_000))) ?? 0;
    let prunedChangeEvents = 0;
    if (this.changeFeedRetention) {
      while (true) {
        const count = await this.changeFeedRetention.pruneExpiredBatch(
          this.changeRetentionDays,
          CLEANUP_BATCH_SIZE,
        );
        if (count === 0) break;
        prunedChangeEvents += count;
      }
    }
    let prunedTrashItems = 0;
    let prunedTrashBytes = 0n;
    if (this.trashRetention) {
      while (true) {
        const batch = await this.trashRetention.pruneExpiredBatch(CLEANUP_BATCH_SIZE);
        prunedTrashItems += batch.items;
        prunedTrashBytes += BigInt(batch.bytes);
        if (batch.items === 0) break;
      }
    }

    this.logger.log(
      `GC 완료: orphan object ${deletedOrphanObjects}건, orphan blob ${deletedOrphanBlobs}건 삭제`,
    );
    return {
      deletedOrphanObjects,
      deletedOrphanBlobs,
      prunedMutationReceipts,
      expiredUploadSessions,
      recoveredUploadSessions,
      deletedStagingObjects,
      prunedUploadSessions,
      prunedChangeEvents,
      prunedTrashItems,
      prunedTrashBytes: prunedTrashBytes.toString(),
    };
  }

  // metadata 없는 MinIO object: 버킷 전체 목록과 DB의 전체 storage_key 집합을
  // 대조한다. storage key에는 namespace 정보가 없어 namespace 단위로 좁힐 수 없다.
  // 'blobs/' prefix로 스캔 범위를 좁혀, STORIX_STORAGE_BUCKET에 Storix가 만들지 않은
  // object가 섞여 있어도 삭제 대상에서 제외한다(StorageKeyGenerator.generate()
  // 참고: 모든 key는 `blobs/{shard}/{uuid}` 형식).
  private async collectOrphanObjects(cutoff: Date): Promise<number> {
    const knownKeys = await this.blobRepository.findAllStorageKeys();
    const knownStagingKeys = await this.uploadSessions?.findAllStagingKeys();
    const staleKeys: string[] = [];

    for await (const item of this.storage.list('blobs/')) {
      if (!knownKeys.has(item.key) && item.lastModified < cutoff) {
        staleKeys.push(item.key);
      }
    }

    if (knownStagingKeys) {
      for await (const item of this.storage.list('upload-staging/')) {
        if (!knownStagingKeys.has(item.key) && item.lastModified < cutoff) staleKeys.push(item.key);
      }
    }

    return this.deleteKeysInChunks(staleKeys);
  }

  // reference_count=0인 Blob: MinIO object 삭제가 끝난 뒤 성공한 것만 모아
  // metadata row를 일괄 삭제한다. Postgres row lock을 MinIO I/O 동안 들고 있지
  // 않기 위해 후보 조회에는 FOR UPDATE를 쓰지 않는다.
  private async collectOrphanBlobs(cutoff: Date): Promise<number> {
    const orphans = await this.blobRepository.findOrphanBlobs(cutoff);
    if (orphans.length === 0) {
      return 0;
    }

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
    return deletedIds.length;
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
