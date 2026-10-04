/** 종료 신호와 타이머에 따른 앱 종료 순서를 가짜 프로세스로 검증한다. 규칙은 api ADR-0043이다. */
import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  installGracefulShutdown,
  parseShutdownTimeoutMs,
  type ShutdownApp,
} from '../../src/common/graceful-shutdown.js';

/** 실제 프로세스 대신 EventEmitter와 jest.fn으로 종료 순서를 검증하는 하니스를 만든다. */
function createHarness(timeoutMs = 25000) {
  const signals = new EventEmitter();
  const exit = jest.fn<(code: number) => void>();
  const closeAllConnections = jest.fn();
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let resolveClose: () => void = () => undefined;
  let rejectClose: (error: Error) => void = () => undefined;
  const close = jest.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      }),
  );
  const app: ShutdownApp = { close, getHttpServer: () => ({ closeAllConnections }) };

  installGracefulShutdown(app, timeoutMs, { signalSource: signals, exit, logger });

  return {
    signals,
    exit,
    close,
    closeAllConnections,
    logger,
    finishClose: () => resolveClose(),
    failClose: (error: Error) => rejectClose(error),
  };
}

/** 마이크로태스크를 비워 close().then 콜백이 실행되게 한다. */
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// 실제 `dist/main.js` 종료 동작은 graceful-shutdown.integration-spec.ts가 검증한다.
describe('installGracefulShutdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('SIGTERM을 받으면 app.close()를 호출하고 완료 전에는 종료하지 않는다', async () => {
    const h = createHarness();

    h.signals.emit('SIGTERM', 'SIGTERM');
    await flushPromises();

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('SIGINT도 같은 종료 절차를 시작한다', async () => {
    const h = createHarness();

    h.signals.emit('SIGINT', 'SIGINT');
    await flushPromises();

    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('close()가 상한 안에 끝나면 exit 0으로 종료하고 연결을 강제로 끊지 않는다', async () => {
    const h = createHarness(25000);

    h.signals.emit('SIGTERM', 'SIGTERM');
    jest.advanceTimersByTime(10000);
    h.finishClose();
    await flushPromises();

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.closeAllConnections).not.toHaveBeenCalled();
  });

  it('close()가 끝난 뒤에는 상한 타이머가 발화하지 않는다', async () => {
    const h = createHarness(25000);

    h.signals.emit('SIGTERM', 'SIGTERM');
    h.finishClose();
    await flushPromises();
    jest.advanceTimersByTime(60000);

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.closeAllConnections).not.toHaveBeenCalled();
  });

  it('상한을 넘기면 연결을 강제로 끊고 exit 1로 종료한다', async () => {
    const h = createHarness(25000);

    h.signals.emit('SIGTERM', 'SIGTERM');
    jest.advanceTimersByTime(24999);
    expect(h.exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(h.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('상한 초과로 종료한 뒤 close()가 늦게 끝나도 exit를 다시 호출하지 않는다', async () => {
    const h = createHarness(1000);

    h.signals.emit('SIGTERM', 'SIGTERM');
    jest.advanceTimersByTime(1000);
    h.finishClose();
    await flushPromises();

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('close()가 실패하면 오류를 기록하고 exit 1로 종료한다', async () => {
    const h = createHarness();

    h.signals.emit('SIGTERM', 'SIGTERM');
    h.failClose(new Error('destroy 실패'));
    await flushPromises();

    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.logger.error).toHaveBeenCalled();
    expect(h.closeAllConnections).not.toHaveBeenCalled();
  });

  it('종료 중 두 번째 신호를 받으면 즉시 exit 1로 종료한다', async () => {
    const h = createHarness();

    h.signals.emit('SIGTERM', 'SIGTERM');
    h.signals.emit('SIGINT', 'SIGINT');

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});

// 환경변수 파싱은 부팅 단계에서 잘못된 종료 상한을 거부해야 한다.
describe('parseShutdownTimeoutMs', () => {
  it('값이 없거나 빈 문자열이면 25초를 돌려준다', () => {
    expect(parseShutdownTimeoutMs(undefined)).toBe(25000);
    expect(parseShutdownTimeoutMs('')).toBe(25000);
  });

  it('초 단위 양의 정수를 밀리초로 바꾼다', () => {
    expect(parseShutdownTimeoutMs('1')).toBe(1000);
    expect(parseShutdownTimeoutMs('3600')).toBe(3600000);
  });

  it.each(['0', '-1', '1.5', '1e3', ' 5', 'abc', '3601'])('%s는 거부한다', (value) => {
    expect(() => parseShutdownTimeoutMs(value)).toThrow('잘못된 정수 환경변수 값');
  });
});
