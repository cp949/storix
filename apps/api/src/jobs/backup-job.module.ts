import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { BackupJob } from './backup.job.js';
import { PgDumpCliTool } from './pg-dump-cli.tool.js';

// gc-job.module.ts의 주석 참고 — job별 env var가 다르므로 모듈을 분리한다.
@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [BackupJob, PgDumpCliTool],
  exports: [BackupJob],
})
export class BackupJobModule {}
