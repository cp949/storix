import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { InvalidApiKeyError } from './auth.errors.js';
import { VALID_API_KEYS } from './auth.constants.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

const BEARER_PREFIX = 'Bearer ';

function isValidKey(candidate: string, validKeys: readonly string[]): boolean {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  return validKeys.some((validKey) => {
    const validBuffer = Buffer.from(validKey, 'utf8');
    return candidateBuffer.length === validBuffer.length && timingSafeEqual(candidateBuffer, validBuffer);
  });
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(VALID_API_KEYS) private readonly validKeys: string[],
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      this.logAuthFailure(request, 'missing_or_malformed_header');
      throw new InvalidApiKeyError();
    }

    const candidate = header.slice(BEARER_PREFIX.length);
    if (!isValidKey(candidate, this.validKeys)) {
      this.logAuthFailure(request, 'key_mismatch');
      throw new InvalidApiKeyError();
    }

    return true;
  }

  private logAuthFailure(request: Request, reason: 'missing_or_malformed_header' | 'key_mismatch'): void {
    this.logger.warn(JSON.stringify({ requestId: request.requestId, path: request.path, reason }));
  }
}
