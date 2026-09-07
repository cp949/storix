import { EventEmitter } from 'node:events';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { jest } from '@jest/globals';
import { of } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor.js';
import type { MetricsRegistry } from './metrics-registry.js';

function createContext(requestHeaders: Record<string, string> = {}) {
  const request = { startTime: Date.now() - 5, headers: requestHeaders };
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeader: () => undefined as string | number | undefined,
  });
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => ({ name: 'FsController' }),
    getHandler: () => ({ name: 'upload' }),
  } as unknown as ExecutionContext;

  return { context, request, response };
}

function createFakeRegistry() {
  const counterIncMocks = new Map<string, ReturnType<typeof jest.fn>>();
  const histogramObserveMocks = new Map<string, ReturnType<typeof jest.fn>>();

  const registry: MetricsRegistry = {
    counter: (name) => {
      let inc = counterIncMocks.get(name);
      if (!inc) {
        inc = jest.fn();
        counterIncMocks.set(name, inc);
      }
      return { inc };
    },
    histogram: (name) => {
      let observe = histogramObserveMocks.get(name);
      if (!observe) {
        observe = jest.fn();
        histogramObserveMocks.set(name, observe);
      }
      return { observe };
    },
  };

  return { registry, counterIncMocks, histogramObserveMocks };
}

describe('MetricsInterceptor', () => {
  it('응답이 끝나면 operation/status 라벨로 요청 카운터를 증가시킨다', (done) => {
    const { registry, counterIncMocks } = createFakeRegistry();
    const interceptor = new MetricsInterceptor(registry);
    const { context, response } = createContext();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      expect(counterIncMocks.get('storix_http_requests_total')).toHaveBeenCalledWith({
        operation: 'FsController.upload',
        status: '200',
      });
      done();
    });
  });

  it('응답이 끝나면 처리 시간을 초 단위로 histogram에 기록한다', (done) => {
    const { registry, histogramObserveMocks } = createFakeRegistry();
    const interceptor = new MetricsInterceptor(registry);
    const { context, response } = createContext();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      const observeMock = histogramObserveMocks.get('storix_http_request_duration_seconds');
      expect(observeMock).toHaveBeenCalledWith(expect.any(Number), { operation: 'FsController.upload' });
      const [durationArg] = observeMock!.mock.calls[0] as [number, unknown];
      expect(durationArg).toBeLessThan(1);
      done();
    });
  });

  it('content-length가 있으면 전송 바이트 카운터를 그 값만큼 증가시킨다', (done) => {
    const { registry, counterIncMocks } = createFakeRegistry();
    const interceptor = new MetricsInterceptor(registry);
    const { context, response } = createContext({ 'content-length': '2048' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      expect(counterIncMocks.get('storix_http_transferred_bytes_total')).toHaveBeenCalledWith(
        { operation: 'FsController.upload' },
        2048,
      );
      done();
    });
  });

  it('content-length 정보가 전혀 없으면 전송 바이트 카운터를 증가시키지 않는다', (done) => {
    const { registry, counterIncMocks } = createFakeRegistry();
    const interceptor = new MetricsInterceptor(registry);
    const { context, response } = createContext();
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    interceptor.intercept(context, handler).subscribe(() => {
      response.emit('close');
      expect(counterIncMocks.get('storix_http_transferred_bytes_total')).not.toHaveBeenCalled();
      done();
    });
  });
});
