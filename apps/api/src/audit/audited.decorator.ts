import { SetMetadata } from '@nestjs/common';

export const AUDITED_KEY = 'audited';
// @Public()은 서비스 API key 가드만 우회한다. 별도 가드(예: admin key)로 보호하는 라우트는
// 이 데코레이터로 AuditLogInterceptor의 공개 경로 제외를 해제해 감사 기록을 남긴다.
export const Audited = () => SetMetadata(AUDITED_KEY, true);
