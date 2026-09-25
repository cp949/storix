import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { InvalidApiKeyError } from './auth.errors.js';

function matches(candidate: string, validKeys: readonly string[]): boolean {
  const candidateBytes = Buffer.from(candidate, 'utf8');
  return validKeys.some((validKey) => {
    const validBytes = Buffer.from(validKey, 'utf8');
    return candidateBytes.length === validBytes.length && timingSafeEqual(candidateBytes, validBytes);
  });
}

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const validKeys = resolveAdminKeys(
      this.config.get<string>('STORIX_ADMIN_API_KEY'),
      this.config.get<string>('STORIX_ADMIN_API_KEY_PREVIOUS'),
    );
    if (
      typeof header !== 'string' ||
      !header.startsWith('Bearer ') ||
      !matches(header.slice('Bearer '.length), validKeys)
    ) {
      throw new InvalidApiKeyError();
    }
    return true;
  }
}

export function resolveAdminKeys(current: string | undefined, previous: string | undefined): string[] {
  if (!current?.trim()) return [];
  return previous?.trim() ? [current, previous] : [current];
}
