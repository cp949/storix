import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { InvalidApiKeyError } from './auth.errors.js';
import { VALID_API_KEYS } from './auth.constants.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

const BEARER_PREFIX = 'Bearer ';

function isValidKey(candidate: string, validKeys: readonly string[]): boolean {
  return validKeys.some((validKey) => {
    if (candidate.length !== validKey.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(validKey));
  });
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
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
      throw new InvalidApiKeyError();
    }

    const candidate = header.slice(BEARER_PREFIX.length);
    if (!isValidKey(candidate, this.validKeys)) {
      throw new InvalidApiKeyError();
    }

    return true;
  }
}
