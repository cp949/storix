/**
 * 소유권 claim으로 미완료 multipart upload 한 건의 abort를 보호한다.
 * abort가 정착할 때까지 claim을 유지한다. 규칙은 api ADR-0045다.
 */
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { StoragePutOwnershipRepository } from '../persistence/storage-put-ownership.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';

type Storage = Pick<BlobStorage, 'abortIncompleteUpload'>;
type Ownership = Pick<StoragePutOwnershipRepository, 'claimForGc' | 'releaseGcClaim'>;

/** 소유권을 확인한 뒤 미완료 multipart upload 한 건을 회수한다. */
export class OwnedMultipartCleanup {
  private readonly logger = new Logger('GcJob');

  constructor(
    private readonly storage: Storage,
    private readonly ownership?: Ownership,
    private readonly executionId?: string,
  ) {}

  /** claim을 얻은 경우에만 abort하고, 자신이 얻은 claim을 해제한다. */
  async abort(key: string, uploadId: string): Promise<boolean> {
    if (!this.ownership || !this.executionId) {
      this.logger.warn(`소유권 확인기가 없어 미완료 multipart upload abort 보류: ${key} (${uploadId})`);
      return false;
    }

    const claimId = randomUUID();
    let claimed = false;
    try {
      const result = await this.ownership.claimForGc(key, claimId, this.executionId);
      if (result.kind !== 'claimed') {
        this.logger.warn(`multipart 소유권 ${result.kind} 상태로 abort 보류: ${key} (${uploadId})`);
        return false;
      }
      claimed = true;
      await this.storage.abortIncompleteUpload(key, uploadId);
      return true;
    } catch (error) {
      this.logger.error(`multipart 소유권 확인 또는 abort 실패: ${key} (${uploadId})`, error);
      return false;
    } finally {
      if (claimed) {
        try {
          await this.ownership.releaseGcClaim(key, claimId);
        } catch (error) {
          this.logger.error(`multipart GC claim 해제 실패: ${key} (${claimId})`, error);
        }
      }
    }
  }
}
