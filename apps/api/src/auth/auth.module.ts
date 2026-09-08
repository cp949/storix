import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard.js';
import { VALID_API_KEYS } from './auth.constants.js';

export function resolveValidApiKeys(current: string, previous: string | undefined): string[] {
  if (current.trim().length === 0) {
    throw new Error('STORIX_API_KEY는 비어 있을 수 없다 — openssl rand -hex 32 로 생성한 값을 설정한다.');
  }
  return previous ? [current, previous] : [current];
}

@Module({
  providers: [
    {
      provide: VALID_API_KEYS,
      useFactory: (config: ConfigService) =>
        resolveValidApiKeys(config.getOrThrow<string>('STORIX_API_KEY'), config.get<string>('STORIX_API_KEY_PREVIOUS')),
      inject: [ConfigService],
    },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AuthModule {}
