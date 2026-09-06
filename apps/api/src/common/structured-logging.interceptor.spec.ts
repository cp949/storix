import { EventEmitter } from 'node:events';
import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { of } from 'rxjs';
import { StructuredLoggingInterceptor } from './structured-logging.interceptor.js';

function createContext(params: Record<string, string>, requestHeaders: Record<string, string> = {}) {
  const request = { requestId: 'req-1', startTime: Date.now() - 5, params, headers: requestHeaders };
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeader: () => undefined as string | number | undefined,
  });
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => ({ name: 'FsController' }),
    getHandler: () => ({ name: 'mkdir' }),
  } as unknown as ExecutionContext;

  return { context, request, response };
}

describe('StructuredLoggingInterceptor', () => {
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('응답이 끝나면 requestId/namespaceId/operation/status/duration을 JSON 한 줄로 로깅한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');

      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged).toMatchObject({
        requestId: 'req-1',
        namespaceId: 'ns-1',
        operation: 'FsController.mkdir',
        status: 200,
      });
      expect(typeof logged.duration).toBe('number');
      done();
    });
  });

  it('namespace 라우트처럼 params.id만 있으면 이를 namespaceId로 기록한다', (done) => {
    const { context, response } = createContext({ id: 'ns-2' });
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.namespaceId).toBe('ns-2');
      done();
    });
  });

  it('byte count는 request content-length를 response보다 우선한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' }, { 'content-length': '2048' });
    response.getHeader = () => '16';
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.byteCount).toBe(2048);
      done();
    });
  });

  it('request content-length가 없으면 response content-length를 쓴다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    response.getHeader = () => '512';
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.byteCount).toBe(512);
      done();
    });
  });

  it('request content-length가 0이면 값 없음이 아니라 0으로 기록한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' }, { 'content-length': '0' });
    response.getHeader = () => '512';
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.byteCount).toBe(0);
      done();
    });
  });

  it('구독 이후 상태 코드가 바뀌어도(@HttpCode 등) 최종 상태를 기록한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of(undefined) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.statusCode = 204;
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.status).toBe(204);
      done();
    });
  });

  it('finish 없이 close만 발생해도(응답이 destroy된 경우) 로그를 남긴다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    response.statusCode = 500;
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.status).toBe(500);
      done();
    });
  });
});
