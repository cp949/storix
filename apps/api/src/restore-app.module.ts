import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RestoreJobModule } from './jobs/restore-job.module.js';
import { ObservabilityModule } from './observability/observability.module.js';

export { RestoreJob } from './jobs/restore.job.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, RestoreJobModule],
})
export class RestoreAppModule {}
