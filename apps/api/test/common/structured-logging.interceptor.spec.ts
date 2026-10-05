import { EventEmitter } from 'node:events';
import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { of } from 'rxjs';
import { StructuredLoggingInterceptor } from '../../src/common/structured-logging.interceptor.js';

function createContext(
  params: Record<string, string>,
  requestHeaders: Record<string, string> = {},
  socket: { bytesRead: number; bytesWritten: number } | null = null,
) {
  const request = { requestId: 'req-1', startTime: Date.now() - 5, params, headers: requestHeaders, socket };
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: true,
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

  it('byteCount는 Content-Length가 아닌 소켓의 수신·송신 바이트 합이다', (done) => {
    const { context, response } = createContext(
      { namespaceId: 'ns-1' },
      { 'content-length': '2048' },
      { bytesRead: 40, bytesWritten: 60 },
    );
    response.getHeader = () => '16';
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.byteCount).toBe(100);
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

  it('finish 없이 close만 발생해도(응답이 destroy된 경우) 로그를 남기고 status는 499다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    response.statusCode = 500;
    response.writableFinished = false;
    const interceptor = new StructuredLoggingInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.status).toBe(499);
      done();
    });
  });

  it('응답 전에 클라이언트가 연결을 끊으면 기본 statusCode 200 대신 499를 기록한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    response.writableFinished = false;
    const interceptor = new StructuredLoggingInterceptor();

    interceptor.intercept(context, { handle: () => of({ ok: true }) }).subscribe(() => {
      response.emit('close');
      expect(JSON.parse(logSpy.mock.calls[0][0] as string).status).toBe(499);
      done();
    });
  });
});
