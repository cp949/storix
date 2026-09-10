import { Module } from '@nestjs/common';
import { DemoWasConfigModule } from './config/demo-was-config.module.js';
import { DocumentArchiveModule } from './document-archive/document-archive.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [DemoWasConfigModule, DocumentArchiveModule],
  controllers: [HealthController],
})
export class AppModule {}
