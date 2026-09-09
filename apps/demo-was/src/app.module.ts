import { Module } from '@nestjs/common';
import { DemoWasConfigModule } from './config/demo-was-config.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [DemoWasConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
