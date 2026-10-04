import { Logger } from '@nestjs/common';
import { parsePositiveInt } from './env-parsing.js';

/** 종료 대기 상한의 기본값(초)이다. compose `stop_grace_period`(30초)보다 짧게 둔다. */
const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 25;

/** 종료 대기 상한(초)의 최댓값이다. */
const MAX_SHUTDOWN_TIMEOUT_SECONDS = 3600;

const HANDLED_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** `installGracefulShutdown`이 종료할 때 쓰는 Nest 앱의 최소 표면이다. */
export interface ShutdownApp {
  /** 새 연결을 막고 진행 중 요청을 기다린 뒤 모듈 종료 훅(`DataSource.destroy()` 등)을 실행한다. */
  close(): Promise<void>;

  /** 상한 초과 시 남은 연결을 끊기 위해 쓰는 HTTP 서버다. */
  getHttpServer(): { closeAllConnections(): void };
}

/** 종료 신호를 구독할 수 있는 대상이다. 실제로는 `process`다. */
export interface SignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', listener: (signal: string) => void): unknown;
}

/** 테스트에서 프로세스·종료·로거를 바꿔 끼우기 위한 의존성이다. 생략하면 실제 프로세스를 쓴다. */
export interface ShutdownDeps {
  /** 종료 신호를 받는 곳이다. 기본값은 `process`다. */
  signalSource?: SignalSource;

  /** 프로세스를 끝내는 함수다. 기본값은 `process.exit`다. */
  exit?: (code: number) => void;

  /** 종료 경과를 남기는 로거다. 기본값은 `Logger('Shutdown')`다. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

/**
 * `STORIX_SHUTDOWN_TIMEOUT_SECONDS`를 읽어 종료 대기 상한(ms)을 돌려준다.
 * 값이 없거나 빈 문자열이면 25초다. 1~3600 범위의 10진 정수 초만 허용하고 그 밖은 부팅을 거부한다.
 */
export function parseShutdownTimeoutMs(value: string | undefined): number {
  return parsePositiveInt(value, DEFAULT_SHUTDOWN_TIMEOUT_SECONDS, MAX_SHUTDOWN_TIMEOUT_SECONDS) * 1000;
}

/**
 * SIGTERM·SIGINT에서 진행 중 요청을 기다린 뒤 종료하는 핸들러를 등록한다.
 * Nest `enableShutdownHooks()`는 상한을 줄 수 없고 종료 뒤 신호를 다시 보내므로 쓰지 않는다.
 *
 * 종료 코드:
 * - `app.close()`가 상한 안에 끝나면 0이다.
 * - 상한을 넘기면 남은 연결을 끊고 1이다.
 * - `app.close()`가 실패하면 1이다.
 * - 종료 중 신호가 다시 오면 기다리지 않고 1이다.
 *
 * 컨테이너에서는 node가 PID 1이므로 핸들러가 없으면 SIGTERM이 무시된다. 결정은 api ADR-0043.
 */
export function installGracefulShutdown(app: ShutdownApp, timeoutMs: number, deps: ShutdownDeps = {}): void {
  const signalSource = deps.signalSource ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logger = deps.logger ?? new Logger('Shutdown');

  let shuttingDown = false;
  let finished = false;

  // exit가 실제로 프로세스를 끝내지 않는 환경(테스트)에서 종료 코드가 두 번 나가지 않게 한다.
  const finish = (code: number): void => {
    if (finished) {
      return;
    }
    finished = true;
    exit(code);
  };

  const onSignal = (signal: string): void => {
    if (shuttingDown) {
      logger.warn(`종료 중 ${signal}을 다시 받아 즉시 종료`);
      finish(1);
      return;
    }
    shuttingDown = true;
    logger.log(`${signal} 수신: 진행 중 요청을 최대 ${timeoutMs / 1000}초 기다린 뒤 종료`);

    const timer = setTimeout(() => {
      logger.error(`종료 대기 ${timeoutMs / 1000}초 초과: 남은 연결을 끊고 종료`);
      app.getHttpServer().closeAllConnections();
      finish(1);
    }, timeoutMs);

    app.close().then(
      () => {
        clearTimeout(timer);
        finish(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        logger.error('종료 처리 실패', error instanceof Error ? error.stack : String(error));
        finish(1);
      },
    );
  };

  for (const signal of HANDLED_SIGNALS) {
    signalSource.on(signal, onSignal);
  }
}
