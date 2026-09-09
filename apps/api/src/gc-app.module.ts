import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GcJobModule } from './jobs/gc-job.module.js';
import { ObservabilityModule } from './observability/observability.module.js';

export { GcJob } from './jobs/gc.job.js';
export { GcLock } from './jobs/gc-lock.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule, GcJobModule],
})
export class GcAppModule {}
