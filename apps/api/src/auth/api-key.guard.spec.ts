import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyGuard } from './api-key.guard.js';
import { InvalidApiKeyError } from './auth.errors.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

function createContext(authorization: string | undefined, isPublic = false): ExecutionContext {
  const handler = function handler() {};
  const clazz = class TestController {};
  if (isPublic) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }
  const headers = authorization === undefined ? {} : { authorization };
  const request = { headers } as unknown as Request;

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => clazz,
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  const reflector = new Reflector();
  const guard = new ApiKeyGuard(reflector, ['current-key', 'previous-key']);

  it('@Public() 라우트는 키 없이 통과한다', () => {
    expect(guard.canActivate(createContext(undefined, true))).toBe(true);
  });

  it('현재 키와 일치하면 통과한다', () => {
    expect(guard.canActivate(createContext('Bearer current-key'))).toBe(true);
  });

  it('이전 키와 일치해도 통과한다', () => {
    expect(guard.canActivate(createContext('Bearer previous-key'))).toBe(true);
  });

  it('Authorization 헤더가 없으면 InvalidApiKeyError를 던진다', () => {
    expect(() => guard.canActivate(createContext(undefined))).toThrow(InvalidApiKeyError);
  });

  it('Bearer 접두어가 없으면 InvalidApiKeyError를 던진다', () => {
    expect(() => guard.canActivate(createContext('current-key'))).toThrow(InvalidApiKeyError);
  });

  it('키가 일치하지 않으면 InvalidApiKeyError를 던진다', () => {
    expect(() => guard.canActivate(createContext('Bearer wrong-key'))).toThrow(InvalidApiKeyError);
  });

  it('후보 키가 유효 키와 문자열 길이는 같지만 바이트 길이가 다르면 크래시 없이 InvalidApiKeyError를 던진다', () => {
    const multiByteGuard = new ApiKeyGuard(reflector, ['abcde']); // 유효 키는 5바이트
    // '가나다라마'는 length===5(JS 문자열 길이)이지만 UTF-8로는 15바이트다
    expect(() => multiByteGuard.canActivate(createContext('Bearer 가나다라마'))).toThrow(InvalidApiKeyError);
  });
});
