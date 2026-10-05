import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { resolveAdminKeys } from './admin-api-key.guard.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { VALID_API_KEYS } from './auth.constants.js';

export function resolveValidApiKeys(current: string, previous: string | undefined): string[] {
  if (current.trim().length === 0) {
    throw new Error('STORIX_API_KEY는 비어 있을 수 없다 — openssl rand -hex 32 로 생성한 값을 설정한다.');
  }
  return previous ? [current, previous] : [current];
}

// 관리자 키가 서비스 키와 같으면 서비스 키로 관리자 API를 호출할 수 있으므로 부팅을 거부한다.
// 비교는 두 guard처럼 trim 없이 값 그대로 한다. 메시지에는 env 이름만 넣고 키 값은 넣지 않는다.
function assertAdminKeysDistinct(config: ConfigService, serviceKeys: readonly string[]): void {
  const serviceNames = ['STORIX_API_KEY', 'STORIX_API_KEY_PREVIOUS'];
  const adminNames = ['STORIX_ADMIN_API_KEY', 'STORIX_ADMIN_API_KEY_PREVIOUS'];
  const adminKeys = resolveAdminKeys(config.get<string>(adminNames[0]), config.get<string>(adminNames[1]));
  adminKeys.forEach((adminKey, adminIndex) => {
    const serviceIndex = serviceKeys.indexOf(adminKey);
    if (serviceIndex !== -1) {
      throw new Error(
        `${adminNames[adminIndex]}는 ${serviceNames[serviceIndex]}와 같은 값일 수 없다 — 관리자 키는 서비스 키와 다른 값으로 생성한다.`,
      );
    }
  });
}

@Module({
  providers: [
    {
      provide: VALID_API_KEYS,
      useFactory: (config: ConfigService) => {
        const serviceKeys = resolveValidApiKeys(
          config.getOrThrow<string>('STORIX_API_KEY'),
          config.get<string>('STORIX_API_KEY_PREVIOUS'),
        );
        assertAdminKeysDistinct(config, serviceKeys);
        return serviceKeys;
      },
      inject: [ConfigService],
    },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AuthModule {}
