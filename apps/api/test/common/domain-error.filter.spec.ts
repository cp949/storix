import { ArgumentsHost, Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { DomainError } from '../../src/common/domain-error.js';
import { StorageFailureError, StorageUnavailableError } from '../../src/common/storage-failure.errors.js';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';
import type { ErrorReporter } from '../../src/observability/error-reporter.js';
import { SqliteGateTimeoutError } from '../../src/persistence/sqlite-gate.errors.js';
import { VfsPreconditionFailedError, VfsNodeNotFoundError } from '../../src/vfs/vfs.errors.js';
import { InvalidApiKeyError } from '../../src/auth/auth.errors.js';
import type { AuditLogRepository } from '../../src/persistence/audit-log.repository.js';
import type { VfsPreconditionCurrentDto } from '../../src/vfs/dto/node-response.dto.js';

function createHost(requestId = 'req-1') {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const setHeader = jest.fn();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, setHeader }),
      getRequest: () => ({ requestId, method: 'POST', path: '/namespaces/ns-1/files' }),
    }),
  } as unknown as ArgumentsHost;

  return { host, json, status, setHeader };
}

function createFakeErrorReporter(): jest.Mocked<ErrorReporter> {
  return { report: jest.fn() };
}

class FooError extends Error {
  readonly code = 'FOO';
  readonly status = 409;
}

class PathedError extends Error {
  readonly code = 'PATHED';
  readonly status = 404;

  constructor(readonly path: string) {
    super('경로를 찾을 수 없음');
  }
}

class SilencedServerError extends DomainError {
  readonly code = 'SILENCED';
  readonly status = 500;

  override get shouldReport(): boolean {
    return false;
  }
}

class ForcedReportClientError extends DomainError {
  readonly code = 'FORCED_REPORT';
  readonly status = 400;

  override get shouldReport(): boolean {
    return true;
  }
}

const CURRENT: VfsPreconditionCurrentDto = {
  id: '0195f6a0-7c1b-7d3e-8a4f-1234567890ab',
  path: '/a',
  name: 'a',
  type: 'FILE',
  size: 3,
  mimeType: 'text/plain',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  version: 2,
  revision: 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

describe('DomainErrorFilter', () => {
  const filter = new DomainErrorFilter();

  it('명시적 STORAGE_FAILURE만 안전한 500 code와 고정 메시지를 낸다', () => {
    const { host, json, status, setHeader } = createHost();
    filter.catch(new StorageFailureError('private object key'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'STORAGE_FAILURE',
      message: 'Storage failure',
      requestId: 'req-1',
    });
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('명시적 STORAGE_UNAVAILABLE은 503이며 대기 시간이 없으면 Retry-After를 보내지 않는다', () => {
    const { host, json, status, setHeader } = createHost();
    filter.catch(new StorageUnavailableError('private endpoint'), host);
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      code: 'STORAGE_UNAVAILABLE',
      message: 'Storage temporarily unavailable',
      path: undefined,
      requestId: 'req-1',
    });
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('retryAfterSeconds를 가진 오류는 Retry-After 헤더를 붙여 응답한다', () => {
    const { host, json, status, setHeader } = createHost('req-busy');

    filter.catch(new SqliteGateTimeoutError(30_000), host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DB_BUSY', requestId: 'req-busy' }));
  });

  it('retryAfterSeconds가 없는 오류에는 Retry-After 헤더를 붙이지 않는다', () => {
    const { host, setHeader } = createHost();

    filter.catch(new VfsNodeNotFoundError('/a'), host);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('412 오류는 current metadata를 body에 포함한다', () => {
    const { host, json, status } = createHost();

    filter.catch(new VfsPreconditionFailedError('/a', CURRENT), host);

    expect(status).toHaveBeenCalledWith(412);
    expect(json).toHaveBeenCalledWith({
      code: 'VFS_PRECONDITION_FAILED',
      message: 'mutation 전제조건 불일치: /a',
      path: '/a',
      current: CURRENT,
      requestId: 'req-1',
    });
  });

  it('412 오류의 current가 null이면 null을 body에 유지한다', () => {
    const { host, json } = createHost();

    filter.catch(new VfsPreconditionFailedError('/a', null), host);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ current: null }));
  });

  it('current가 없는 다른 DomainError의 body에는 current 키를 넣지 않는다', () => {
    const { host, json } = createHost();

    filter.catch(new VfsNodeNotFoundError('/a'), host);

    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('current');
    expect(body).toEqual({
      code: 'VFS_NODE_NOT_FOUND',
      message: '존재하지 않는 경로: /a',
      path: '/a',
      requestId: 'req-1',
    });
  });

  it('500 응답에는 current를 노출하지 않는다', () => {
    const { host, json } = createHost();

    filter.catch(Object.assign(new Error('boom'), { status: 500, current: CURRENT }), host);

    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('code와 status를 가진 에러를 해당 status와 {code, message, requestId} body로 응답한다', () => {
    const { host, json, status } = createHost();

    filter.catch(new FooError('foo happened'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ code: 'FOO', message: 'foo happened', requestId: 'req-1' });
  });

  it('code/status가 없는 에러는 500과 고정 메시지로 응답하고 원본 메시지를 노출하지 않는다', () => {
    const { host, json, status } = createHost();

    filter.catch(new Error('storage key sk-123.bin 읽기 실패'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('Error가 아닌 값이 던져지면 500과 고정 메시지로 응답한다', () => {
    const { host, json, status } = createHost();

    filter.catch('문자열 예외', host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('exception에 path가 있으면 응답 body에 canonical path를 포함한다', () => {
    const { host, json } = createHost();

    filter.catch(new PathedError('/a/b'), host);

    expect(json).toHaveBeenCalledWith({
      code: 'PATHED',
      message: '경로를 찾을 수 없음',
      path: '/a/b',
      requestId: 'req-1',
    });
  });

  it('request의 requestId를 그대로 응답 body에 포함한다', () => {
    const { host, json } = createHost('req-xyz');

    filter.catch(new FooError('foo happened'), host);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-xyz' }));
  });

  it('API key 거부를 null 주체와 request path로 best-effort 기록하고 401 응답을 유지한다', async () => {
    const audit = { record: jest.fn<AuditLogRepository['record']>().mockResolvedValue(undefined) };
    const request = {
      requestId: 'req-denied',
      method: 'GET',
      path: '/api/v2/namespaces',
      headers: { 'x-caller-id': 'self-claim' },
    };
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => request }),
    } as unknown as ArgumentsHost;
    const filter = new DomainErrorFilter(undefined, audit as unknown as AuditLogRepository);

    filter.catch(new InvalidApiKeyError(), host);
    await new Promise((resolve) => setImmediate(resolve));

    expect(audit.record).toHaveBeenCalledWith({
      requestId: 'req-denied',
      namespaceId: null,
      snapshotId: null,
      trashId: null,
      operation: 'GET /api/v2/namespaces',
      path: '/api/v2/namespaces',
      detail: null,
      caller: null,
      status: 401,
    });
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'UNAUTHORIZED', requestId: 'req-denied' }),
    );
  });

  it('API key 거부 감사 저장이 실패해도 응답은 401이다', async () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const audit = { record: jest.fn<AuditLogRepository['record']>().mockRejectedValue(new Error('db down')) };
    const filter = new DomainErrorFilter(undefined, audit as unknown as AuditLogRepository);
    const { host, json, status } = createHost();
    filter.catch(new InvalidApiKeyError(), host);
    await new Promise((resolve) => setImmediate(resolve));
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(loggerErrorSpy).toHaveBeenCalled();
    loggerErrorSpy.mockRestore();
  });

  it('긴 request path도 audit operation 컬럼 길이에 맞추고 전체 path는 보존한다', async () => {
    const audit = { record: jest.fn<AuditLogRepository['record']>().mockResolvedValue(undefined) };
    const path = `/api/v2/namespaces/${'x'.repeat(180)}`;
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ requestId: 'req-long-path', method: 'GET', path, headers: {} }),
      }),
    } as unknown as ArgumentsHost;
    new DomainErrorFilter(undefined, audit as unknown as AuditLogRepository).catch(
      new InvalidApiKeyError(),
      host,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: `GET ${path}`.slice(0, 128),
        path,
      }),
    );
  });

  it('exception에 code가 있어도 500 응답에서는 INTERNAL_ERROR로 대체한다', () => {
    const { host, json } = createHost();
    const thirdPartyError = Object.assign(new Error('duplicate key value'), { code: '23505' });

    filter.catch(thirdPartyError, host);

    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('500 응답 시 원본 예외 메시지와 스택을 logger.error로 남긴다', () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = createHost();
    const originalError = new Error('storage key sk-123.bin 읽기 실패');

    filter.catch(originalError, host);

    expect(loggerErrorSpy).toHaveBeenCalledWith(originalError.message, originalError.stack);
    loggerErrorSpy.mockRestore();
  });

  it('STORAGE_FAILURE 로그에는 응답에 숨긴 원본 cause stack을 이어 남긴다', () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, json } = createHost();
    const cause = Object.assign(new Error('disk full on /var/lib/postgresql'), { code: '53100' });

    filter.catch(new StorageFailureError(undefined, { cause }), host);

    const [, stack] = loggerErrorSpy.mock.calls[0] as [string, string];
    expect(stack).toContain('Caused by: Error: disk full on /var/lib/postgresql');
    expect(JSON.stringify(json.mock.calls)).not.toContain('disk full');
    loggerErrorSpy.mockRestore();
  });

  it('STORAGE_UNAVAILABLE은 원본 cause를 경고 로그로 남기고 응답에는 노출하지 않는다', () => {
    const loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host, json } = createHost();
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });

    filter.catch(new StorageUnavailableError(undefined, { cause }), host);

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(String(loggerWarnSpy.mock.calls[0][0])).toContain(
      'Caused by: Error: connect ECONNREFUSED 10.0.0.5:5432',
    );
    expect(JSON.stringify(json.mock.calls)).not.toContain('10.0.0.5');
    loggerWarnSpy.mockRestore();
  });

  it('exception에 path가 있어도 500 응답에서는 노출하지 않는다', () => {
    const { host, json } = createHost();
    const thirdPartyError = Object.assign(new Error('ENOENT'), { path: '/etc/passwd' });

    filter.catch(thirdPartyError, host);

    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('status는 있지만 code가 없는 예외(예: body-parser 오류)는 BAD_REQUEST로 응답한다', () => {
    const { host, json, status } = createHost();
    const bodyParserLikeError = Object.assign(new Error('Unexpected token b in JSON'), { status: 400 });

    filter.catch(bodyParserLikeError, host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      code: 'BAD_REQUEST',
      message: 'Unexpected token b in JSON',
      requestId: 'req-1',
    });
  });

  it('500 에러가 발생하면 주입된 ErrorReporter.report를 호출한다', () => {
    const errorReporter = createFakeErrorReporter();
    const filterWithReporter = new DomainErrorFilter(errorReporter);
    const { host } = createHost();
    const originalError = new Error('storage key sk-123.bin 읽기 실패');

    filterWithReporter.catch(originalError, host);

    expect(errorReporter.report).toHaveBeenCalledWith(originalError, {
      requestId: 'req-1',
      path: 'POST /namespaces/ns-1/files',
    });
  });

  it('요청 URL에 쿼리스트링이 있어도 ErrorReporter에는 쿼리스트링을 제외한 path만 전달한다', () => {
    const errorReporter = createFakeErrorReporter();
    const filterWithReporter = new DomainErrorFilter(errorReporter);
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({
          requestId: 'req-1',
          method: 'GET',
          path: '/namespaces/ns-1/files',
          originalUrl: '/namespaces/ns-1/files?presigned-signature=secret-token',
        }),
      }),
    } as unknown as ArgumentsHost;

    filterWithReporter.catch(new Error('boom'), host);

    expect(errorReporter.report).toHaveBeenCalledWith(expect.any(Error), {
      requestId: 'req-1',
      path: 'GET /namespaces/ns-1/files',
    });
  });

  it('4xx 에러는 ErrorReporter.report를 호출하지 않는다', () => {
    const errorReporter = createFakeErrorReporter();
    const filterWithReporter = new DomainErrorFilter(errorReporter);
    const { host } = createHost();

    filterWithReporter.catch(new FooError('foo happened'), host);

    expect(errorReporter.report).not.toHaveBeenCalled();
  });

  it('DomainError가 shouldReport를 false로 override하면 500이어도 ErrorReporter.report를 호출하지 않는다', () => {
    const errorReporter = createFakeErrorReporter();
    const filterWithReporter = new DomainErrorFilter(errorReporter);
    const { host, json, status } = createHost();

    filterWithReporter.catch(new SilencedServerError('내부 문제'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
    expect(errorReporter.report).not.toHaveBeenCalled();
  });

  it('DomainError가 shouldReport를 true로 override하면 4xx여도 ErrorReporter.report를 호출한다', () => {
    const errorReporter = createFakeErrorReporter();
    const filterWithReporter = new DomainErrorFilter(errorReporter);
    const { host } = createHost();
    const error = new ForcedReportClientError('강제 리포트 대상');

    filterWithReporter.catch(error, host);

    expect(errorReporter.report).toHaveBeenCalledWith(error, {
      requestId: 'req-1',
      path: 'POST /namespaces/ns-1/files',
    });
  });

  it('ErrorReporter가 주입되지 않아도 500 처리에 영향을 주지 않는다', () => {
    const filterWithoutReporter = new DomainErrorFilter();
    const { host, json, status } = createHost();

    expect(() => filterWithoutReporter.catch(new Error('boom'), host)).not.toThrow();
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });
});
