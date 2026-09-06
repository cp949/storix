import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard.js';
import { VALID_API_KEYS } from './auth.constants.js';

export function resolveValidApiKeys(current: string, previous: string | undefined): string[] {
  return previous ? [current, previous] : [current];
}

@Module({
  providers: [
    {
      provide: VALID_API_KEYS,
      useFactory: (config: ConfigService) =>
        resolveValidApiKeys(config.getOrThrow<string>('API_KEY'), config.get<string>('API_KEY_PREVIOUS')),
      inject: [ConfigService],
    },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AuthModule {}
