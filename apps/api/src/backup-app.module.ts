import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BackupJobModule } from './jobs/backup-job.module.js';
import { ObservabilityModule } from './observability/observability.module.js';

export { BackupJob } from './jobs/backup.job.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, BackupJobModule],
})
export class BackupAppModule {}
