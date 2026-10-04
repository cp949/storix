import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AuditLogInterceptor } from './audit-log.interceptor.js';
import { AUTH_REJECT_AUDIT_LIMITER, AuthRejectAuditLimiter } from './auth-reject-audit-limiter.js';

// 컨트롤러의 @UseFilters(DomainErrorFilter)는 각 기능 모듈 DI로 생성되므로, 401 감사 기록 상한 상태를
// 앱 하나에서 공유하려면 리미터를 전역으로 노출해야 한다.
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
    { provide: AUTH_REJECT_AUDIT_LIMITER, useFactory: () => new AuthRejectAuditLimiter() },
  ],
  exports: [AUTH_REJECT_AUDIT_LIMITER],
})
export class AuditModule {}
