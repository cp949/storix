import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { HealthController } from './health.controller.js';
import { MinioHealthIndicator } from './minio-health.indicator.js';

@Module({
  imports: [TerminusModule, PersistenceModule, StorageModule],
  controllers: [HealthController],
  providers: [MinioHealthIndicator],
})
export class HealthModule {}
