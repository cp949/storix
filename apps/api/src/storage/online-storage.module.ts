/**
 * 온라인 PUT에 durable 소유권 래퍼를 제공한다.
 * - 실행 식별자는 API 실행마다 새로 만든다.
 * - 규칙은 api ADR-0045다.
 */
import { Logger, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { BlobStorage } from './blob-storage.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StoragePutOwnershipRepository } from '../persistence/storage-put-ownership.repository.js';
import { BLOB_STORAGE, RAW_BLOB_STORAGE } from './storage.constants.js';
import { PutProtectedBlobStorage } from './put-protected-blob-storage.js';
import { StorageModule } from './storage.module.js';

/** 현재 프로세스에서 PUT 시도에 기록할 실행 식별자 토큰이다. */
export const STORAGE_PUT_EXECUTION_ID = Symbol('STORAGE_PUT_EXECUTION_ID');

@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [
    {
      provide: STORAGE_PUT_EXECUTION_ID,
      useFactory: async (ownership: StoragePutOwnershipRepository): Promise<string> => {
        const executionId = randomUUID();
        await ownership.registerExecution(executionId);
        new Logger('StoragePutExecution').log(`storage PUT 실행 식별자: ${executionId}`);
        return executionId;
      },
      inject: [StoragePutOwnershipRepository],
    },
    {
      provide: BLOB_STORAGE,
      useFactory: (raw: BlobStorage, ownership: StoragePutOwnershipRepository, executionId: string) =>
        new PutProtectedBlobStorage(raw, ownership, executionId),
      inject: [RAW_BLOB_STORAGE, StoragePutOwnershipRepository, STORAGE_PUT_EXECUTION_ID],
    },
  ],
  exports: [BLOB_STORAGE, STORAGE_PUT_EXECUTION_ID, StorageModule],
})
export class OnlineStorageModule {}
