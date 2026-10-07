import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StoragePutOwnershipRepository } from '../persistence/storage-put-ownership.repository.js';
import { StorageModule } from './storage.module.js';
import { BLOB_STORAGE } from './storage.constants.js';
import type { BlobStorage } from './blob-storage.js';
import { StoragePutAdminService } from './storage-put-admin.service.js';

/** 관리자 종료 확인과 legacy multipart CLI에서 사용할 DB·스토리지 계층을 제공한다. */
@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [
    {
      provide: StoragePutAdminService,
      useFactory: (storage: BlobStorage, ownership: StoragePutOwnershipRepository) =>
        new StoragePutAdminService(storage, ownership),
      inject: [BLOB_STORAGE, StoragePutOwnershipRepository],
    },
  ],
  exports: [StoragePutAdminService],
})
export class StoragePutAdminModule {}
