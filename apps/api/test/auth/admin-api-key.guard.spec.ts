import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AdminApiKeyGuard, resolveAdminKeys } from '../../src/auth/admin-api-key.guard.js';
import { InvalidApiKeyError } from '../../src/auth/auth.errors.js';

function context(authorization?: string): ExecutionContext {
  const request = { headers: authorization === undefined ? {} : { authorization } } as unknown as Request;
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('AdminApiKeyGuard', () => {
  it('관리 key가 없으면 admin 경로를 닫는다', () => {
    const guard = new AdminApiKeyGuard(config({}));
    expect(() => guard.canActivate(context('Bearer regular'))).toThrow(InvalidApiKeyError);
  });

  it('regular API key만으로는 admin 경로를 통과하지 못한다', () => {
    expect(() =>
      new AdminApiKeyGuard(config({ STORIX_ADMIN_API_KEY: 'admin-current' })).canActivate(
        context('Bearer regular'),
      ),
    ).toThrow(InvalidApiKeyError);
  });

  it('현재 또는 이전 admin key만 통과시킨다', () => {
    const guard = new AdminApiKeyGuard(
      config({ STORIX_ADMIN_API_KEY: 'admin-current', STORIX_ADMIN_API_KEY_PREVIOUS: 'admin-previous' }),
    );
    expect(guard.canActivate(context('Bearer admin-current'))).toBe(true);
    expect(guard.canActivate(context('Bearer admin-previous'))).toBe(true);
  });

  it('이전 key만 설정되면 비활성화 상태로 처리한다', () => {
    expect(resolveAdminKeys(undefined, 'previous')).toEqual([]);
  });
});

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}
