/** storage PUT 시작 전 소유권을 확정하고 실제 Promise 정착을 기록한다. 규칙은 api ADR-0045다. */
import { Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type {
  BlobPage,
  BlobPageOptions,
  BlobRange,
  BlobStorage,
  IncompleteUploadPage,
  IncompleteUploadPageOptions,
} from './blob-storage.js';
import type { StoragePutOwnershipRepository } from '../persistence/storage-put-ownership.repository.js';

const SETTLE_RETRY_MS = 1000;

/** 온라인 storage PUT가 시작되기 전에 소유 기록을 저장하고 PUT 정착을 기록하는 래퍼다. */
export class PutProtectedBlobStorage implements BlobStorage {
  private readonly logger = new Logger(PutProtectedBlobStorage.name);

  constructor(
    private readonly raw: BlobStorage,
    private readonly ownership: StoragePutOwnershipRepository,
    private readonly executionId: string,
  ) {}

  async put(key: string, stream: Readable, contentType?: string): Promise<void> {
    const attemptId = await this.ownership.beginPut(key, this.executionId);
    try {
      await this.raw.put(key, stream, contentType);
    } finally {
      await this.settleUntilRecorded(attemptId, key);
    }
  }

  get(key: string, range?: BlobRange): Promise<Readable> {
    return this.raw.get(key, range);
  }

  delete(key: string): Promise<void> {
    return this.raw.delete(key);
  }

  list(prefix?: string): AsyncIterable<{ readonly key: string; readonly lastModified: Date }> {
    return this.raw.list(prefix);
  }

  listPage(prefix: string, options: BlobPageOptions): Promise<BlobPage> {
    return this.raw.listPage(prefix, options);
  }

  listIncompleteUploadsPage(
    prefix: string,
    options: IncompleteUploadPageOptions,
  ): Promise<IncompleteUploadPage> {
    return this.raw.listIncompleteUploadsPage(prefix, options);
  }

  abortIncompleteUpload(key: string, uploadId: string): Promise<void> {
    return this.raw.abortIncompleteUpload(key, uploadId);
  }

  getPresignedUrl(key: string, expirySeconds: number, contentDisposition?: string, contentType?: string) {
    return this.raw.getPresignedUrl(key, expirySeconds, contentDisposition, contentType);
  }

  private async settleUntilRecorded(attemptId: string, key: string): Promise<void> {
    for (;;) {
      try {
        await this.ownership.settlePut(attemptId);
        return;
      } catch (error) {
        this.logger.error(`storage PUT 정착 기록 저장 실패: ${key} (${attemptId})`, error);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS));
      }
    }
  }
}
