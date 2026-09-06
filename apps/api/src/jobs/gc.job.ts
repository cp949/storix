import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePositiveInt } from '../common/env-parsing.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';

const DELETE_CONCURRENCY = 20;

export interface GcResult {
  readonly deletedOrphanObjects: number;
  readonly deletedOrphanBlobs: number;
}

@Injectable()
export class GcJob {
  private readonly logger = new Logger(GcJob.name);
  private readonly gracePeriodSeconds: number;

  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly blobRepository: BlobRepository,
    config: ConfigService,
  ) {
    this.gracePeriodSeconds = parsePositiveInt(config.getOrThrow<string>('ORPHAN_GRACE_PERIOD'), 86400);
  }

  async run(): Promise<GcResult> {
    const cutoff = new Date(Date.now() - this.gracePeriodSeconds * 1000);

    const deletedOrphanObjects = await this.collectOrphanObjects(cutoff);
    const deletedOrphanBlobs = await this.collectOrphanBlobs(cutoff);

    this.logger.log(`GC 완료: orphan object ${deletedOrphanObjects}건, orphan blob ${deletedOrphanBlobs}건 삭제`);
    return { deletedOrphanObjects, deletedOrphanBlobs };
  }

  // metadata 없는 MinIO object: 버킷 전체 목록과 DB의 전체 storage_key 집합을
  // 대조한다. storage key에는 namespace 정보가 없어 namespace 단위로 좁힐 수 없다.
  // 'blobs/' prefix로 스캔 범위를 좁혀, MINIO_BUCKET에 Storix가 만들지 않은
  // object가 섞여 있어도 삭제 대상에서 제외한다(StorageKeyGenerator.generate()
  // 참고: 모든 key는 `blobs/{shard}/{uuid}` 형식).
  private async collectOrphanObjects(cutoff: Date): Promise<number> {
    const knownKeys = await this.blobRepository.findAllStorageKeys();
    const staleKeys: string[] = [];

    for await (const item of this.storage.list('blobs/')) {
      if (!knownKeys.has(item.key) && item.lastModified < cutoff) {
        staleKeys.push(item.key);
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
