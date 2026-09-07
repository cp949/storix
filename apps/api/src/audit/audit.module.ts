import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AuditLogInterceptor } from './audit-log.interceptor.js';

@Module({
  imports: [PersistenceModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor }],
})
export class AuditModule {}
