import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { GcJob } from './gc.job.js';

@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [GcJob],
  exports: [GcJob],
})
export class JobsModule {}
