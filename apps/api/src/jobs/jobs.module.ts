import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { BackupJob } from './backup.job.js';
import { GcJob } from './gc.job.js';
import { PgDumpCliTool } from './pg-dump-cli.tool.js';
import { RestoreJob } from './restore.job.js';

@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [GcJob, BackupJob, RestoreJob, PgDumpCliTool],
  exports: [GcJob, BackupJob, RestoreJob],
})
export class JobsModule {}
