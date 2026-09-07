import { EventEmitter } from 'node:events';
import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { jest } from '@jest/globals';
import { of } from 'rxjs';
import { AuditLogInterceptor, resolveCallerId } from './audit-log.interceptor.js';
import type { AuditLogEntry, AuditLogRepository } from '../persistence/audit-log.repository.js';

function createContext(
  params: Record<string, string>,
  options: {
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
) {
  const request = {
    requestId: 'req-1',
    params,
    query: options.query ?? {},
    body: options.body,
    headers: options.headers ?? {},
  };
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => ({ name: 'FsController' }),
    getHandler: () => ({ name: 'mkdir' }),
  } as unknown as ExecutionContext;

  return { context, response };
}

describe('resolveCallerId', () => {
  it('헤더가 없으면 null을 반환한다', () => {
    expect(resolveCallerId(undefined)).toBeNull();
  });

  it('출력 가능한 ASCII 값이면 그대로 반환한다', () => {
    expect(resolveCallerId('billing-service')).toBe('billing-service');
  });

  it('제어 문자가 섞이면 null을 반환한다', () => {
    expect(resolveCallerId('bad\nvalue')).toBeNull();
  });

  it('200자를 넘으면 null을 반환한다', () => {
    expect(resolveCallerId('a'.repeat(201))).toBeNull();
  });

  it('배열로 전달되면 첫 번째 값만 본다', () => {
    expect(resolveCallerId(['first', 'second'])).toBe('first');
  });
});

describe('AuditLogInterceptor', () => {
  let reflector: { getAllAndOverride: jest.Mock<(key: string, targets: unknown[]) => boolean | undefined> };
  let auditLogRepository: { record: jest.Mock<(entry: AuditLogEntry) => Promise<void>> };
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn<(key: string, targets: unknown[]) => boolean | undefined>().mockReturnValue(false) };
    auditLogRepository = { record: jest.fn<(entry: AuditLogEntry) => Promise<void>>().mockResolvedValue(undefined) };
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function createInterceptor(): AuditLogInterceptor {
    return new AuditLogInterceptor(
      reflector as unknown as Reflector,
      auditLogRepository as unknown as AuditLogRepository,
    );
  }

  it('@Public() 라우트는 기록하지 않는다', (done) => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const { context, response } = createContext({});
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record).not.toHaveBeenCalled();
        done();
      });
  });

  it('응답이 끝나면 requestId/namespaceId/operation/path/status를 기록한다', (done) => {
    const { context, response } = createContext(
      { namespaceId: '11111111-1111-1111-1111-111111111111' },
      { query: { path: '/a.txt' } },
    );
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record).toHaveBeenCalledWith({
          requestId: 'req-1',
          namespaceId: '11111111-1111-1111-1111-111111111111',
          operation: 'FsController.mkdir',
          path: '/a.txt',
          detail: null,
          caller: null,
          status: 200,
        });
        done();
      });
  });

  it('namespace 라우트처럼 params.id만 있으면 이를 namespaceId로 기록한다', (done) => {
    const { context, response } = createContext({ id: '22222222-2222-2222-2222-222222222222' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({
          namespaceId: '22222222-2222-2222-2222-222222222222',
        });
        done();
      });
  });

  it('params.id가 UUID 형식이 아니면 namespaceId를 null로 기록한다', (done) => {
    const { context, response } = createContext({ id: 'not-a-uuid' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ namespaceId: null });
        done();
      });
  });

  it('X-Caller-Id 헤더 값을 caller로 기록한다', (done) => {
    const { context, response } = createContext(
      { namespaceId: 'ns-1' },
      { headers: { 'x-caller-id': 'billing-service' } },
    );
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ caller: 'billing-service' });
        done();
      });
  });

  it('mv/cp처럼 body에 source/destination이 있으면 detail에 담는다', (done) => {
    const { context, response } = createContext(
      { namespaceId: 'ns-1' },
      { body: { source: '/a.txt', destination: '/b.txt' } },
    );
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({
          detail: { source: '/a.txt', destination: '/b.txt' },
        });
        done();
      });
  });

  it('namespace 생성처럼 body에 name이 있으면 detail에 담는다', (done) => {
    const { context, response } = createContext({}, { body: { name: 'acme', encryptionPolicy: 'NONE' } });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ detail: { name: 'acme' } });
        done();
      });
  });

  it('기록 실패는 요청을 막지 않고 에러 로그만 남긴다(best-effort)', (done) => {
    auditLogRepository.record.mockRejectedValue(new Error('db down'));
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        queueMicrotask(() => {
          expect(errorSpy).toHaveBeenCalled();
          done();
        });
      });
  });

  it('구독 이후 상태 코드가 바뀌어도(@HttpCode 등) 최종 상태를 기록한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    const handler: CallHandler = { handle: () => of(undefined) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.statusCode = 204;
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ status: 204 });
        done();
      });
  });
});
