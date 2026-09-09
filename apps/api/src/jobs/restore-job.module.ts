import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { DB_DUMP_TOOL } from './db-dump.tool.js';
import { PgDumpCliTool } from './pg-dump-cli.tool.js';
import { RestoreJob } from './restore.job.js';
import { SqliteDumpTool } from './sqlite-dump.tool.js';

// gc-job.module.ts의 주석 참고 — job별 env var가 다르므로 모듈을 분리한다.
@Module({
  imports: [PersistenceModule, StorageModule],
  providers: [
    RestoreJob,
    {
      provide: DB_DUMP_TOOL,
      useFactory: (config: ConfigService) =>
        process.env.STORIX_DB_DRIVER === 'sqlite' ? new SqliteDumpTool(config) : new PgDumpCliTool(config),
      inject: [ConfigService],
    },
  ],
  exports: [RestoreJob],
})
export class RestoreJobModule {}
