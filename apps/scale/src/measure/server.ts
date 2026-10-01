import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { API_MAIN, WORK_DIR } from '../paths.ts';
import { readMemory, trackPeakRss } from './proc.ts';

/** 기동한 API 서버. */
export interface RunningApi {
  readonly baseUrl: string;
  readonly pid: number;
  readonly logFile: string;

  /** spawn부터 `/health/ready`가 200이 될 때까지 걸린 시간(ms). build·migration은 포함하지 않는다. */
  readonly startupMs: number;

  /** 준비 직후 RSS(바이트) */
  readonly readyRssBytes: number;

  /** 지금까지 관측한 RSS 최고값(바이트). 대상 프로세스의 `VmHWM`이다. */
  peakRssBytes(): number;

  /** SIGTERM 후 최대 10초 기다린다. */
  stop(): Promise<void>;
}

/** 비어 있는 로컬 포트 하나를 받는다. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') return reject(new Error('포트를 받지 못했다'));
      probe.close(() => resolve(address.port));
    });
  });
}

function tail(file: string, maxChars = 4000): string {
  const text = readFileSync(file, 'utf-8');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** API 서버 env를 명시적으로 만든다. 부모의 `STORIX_*`가 섞이지 않게 `PATH`만 상속한다. */
export function buildApiEnv(input: {
  readonly port: number;
  readonly apiKey: string;
  readonly adminKey: string;
  readonly databaseEnv: Readonly<Record<string, string>>;
  readonly storageEnv: Readonly<Record<string, string>>;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    STORIX_PORT: String(input.port),
    STORIX_API_KEY: input.apiKey,
    STORIX_ADMIN_API_KEY: input.adminKey,
    ...input.storageEnv,
    ...input.databaseEnv,
    ...input.extraEnv,
  };
}

/**
 * 빌드된 API를 별도 프로세스로 기동하고 준비될 때까지의 시간을 잰다.
 * 시간 제한 안에 준비되지 않으면 프로세스를 종료하고 로그 끝부분이 담긴 오류를 던진다.
 */
export async function startApi(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  readonly label: string;
  readonly timeoutMs?: number;
}): Promise<RunningApi> {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const logFile = path.join(WORK_DIR, `${options.label}.server.log`);
  const logFd = openSync(logFile, 'a');
  const started = performance.now();
  const proc: ChildProcess = spawn(process.execPath, [API_MAIN], {
    cwd: WORK_DIR,
    env: options.env,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    proc.once('exit', () => {
      exited = true;
      resolve();
    }),
  );
  const pid = proc.pid!;
  const tracker = trackPeakRss(pid);
  const stop = async (): Promise<void> => {
    tracker.stop();
    if (exited) return;
    proc.kill('SIGTERM');
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    await exit;
    clearTimeout(killTimer);
  };

  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    if (exited) {
      // 추적 timer를 멈추지 않으면 측정기 프로세스가 끝나지 않는다.
      tracker.stop();
      throw new Error(`API가 기동 중 종료했다(exit ${proc.exitCode}).\n${tail(logFile)}`);
    }
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).status === 200) break;
    } catch {
      // 준비 전 연결 거부는 다시 시도한다.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`API 준비 대기 시간 초과.\n${tail(logFile)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const startupMs = performance.now() - started;
  return {
    baseUrl,
    pid,
    logFile,
    startupMs,
    readyRssBytes: readMemory(pid)?.rssBytes ?? 0,
    peakRssBytes: () => tracker.peak(),
    stop,
  };
}
