import { UploadStagingCleanup } from '../vfs/upload-staging-cleanup.js';
import { NamespaceDeletionCleanup } from './namespace-deletion.cleanup.js';
import { Logger, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StoragePutOwnershipRepository } from '../persistence/storage-put-ownership.repository.js';
import { StorageModule } from '../storage/storage.module.js';
import { STORAGE_PUT_EXECUTION_ID } from '../storage/online-storage.module.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { GcJob } from './gc.job.js';
import { GcLock } from './gc-lock.js';
import { OwnedMultipartCleanup } from './owned-multipart-cleanup.js';

// job별로 모듈을 분리한다 — NestFactory.createApplicationContext는 import된
// 모듈의 모든 provider를 즉시(eager) 생성하므로, 한 모듈에 세 job을 묶으면
// gc 컨테이너를 띄우는 것만으로 BackupJob/RestoreJob 생성자까지 실행돼
// 그쪽 전용 env var(STORIX_BACKUP_DIR, STORIX_RESTORE_SOURCE_DIR) 부재로 부팅이 실패한다.
@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [
    UploadStagingCleanup,
    {
      provide: STORAGE_PUT_EXECUTION_ID,
      useFactory: async (ownership: StoragePutOwnershipRepository): Promise<string> => {
        const executionId = randomUUID();
        await ownership.registerExecution(executionId);
        new Logger('StoragePutExecution').log(`GC 실행 식별자: ${executionId}`);
        return executionId;
      },
      inject: [StoragePutOwnershipRepository],
    },
    {
      provide: OwnedMultipartCleanup,
      useFactory: (
        storage: BlobStorage,
        ownership: StoragePutOwnershipRepository,
        executionId: string,
      ): OwnedMultipartCleanup => new OwnedMultipartCleanup(storage, ownership, executionId),
      inject: [BLOB_STORAGE, StoragePutOwnershipRepository, STORAGE_PUT_EXECUTION_ID],
    },
    GcJob,
    GcLock,
    NamespaceDeletionCleanup,
  ],
  exports: [GcJob, GcLock],
})
export class GcJobModule {}
