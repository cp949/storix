import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { API_MAIN } from './paths.ts';
import { waitUntil } from './wait.ts';

/** `startServer` 입력. */
export interface StartServerOptions {
  readonly port: number;

  /** 서버 프로세스 env. `buildServerEnv`로 만든다. */
  readonly env: NodeJS.ProcessEnv;

  /** 서버 cwd와 로그 파일 위치. `.env`가 없는 디렉터리여야 한다. */
  readonly workDir: string;

  /** 로그 파일 이름에 쓰는 프로필 이름 */
  readonly label: string;
}

/** 기동한 API 서버. */
export interface ServerHandle {
  readonly baseUrl: string;

  /** stdout·stderr를 모은 로그 파일 경로 */
  readonly logFile: string;

  /** SIGTERM으로 종료한다. 10초 안에 끝나지 않으면 SIGKILL이다. 이미 종료했으면 아무것도 하지 않는다. */
  stop(): Promise<void>;

  /** 같은 포트·env로 종료 후 다시 기동한다. 재시작 뒤 지속성을 검증하는 계약이 쓴다. */
  restart(): Promise<void>;
}

/** 로컬 루프백에서 비어 있는 포트를 하나 받는다. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('포트를 할당받지 못했다.'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function tail(file: string, maxChars = 4000): string {
  const text = readFileSync(file, 'utf-8');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

interface RunningServer {
  readonly proc: ChildProcess;
  readonly exit: Promise<void>;
}

/** 아직 종료하지 않은 서버. 기동 대기 중인 서버도 포함해 중단할 때 한꺼번에 정리한다. */
const active = new Set<RunningServer>();

/** SIGTERM으로 종료하고 끝날 때까지 기다린다. 10초 안에 끝나지 않으면 SIGKILL이다. */
async function terminate(server: RunningServer): Promise<void> {
  if (server.proc.exitCode !== null || server.proc.signalCode !== null) return;
  server.proc.kill('SIGTERM');
  const killTimer = setTimeout(() => server.proc.kill('SIGKILL'), 10_000);
  await server.exit;
  clearTimeout(killTimer);
}

/**
 * 이 모듈이 띄운 서버 프로세스를 모두 종료하고 종료한 PID를 돌려준다.
 * 아직 `startServer`가 끝나지 않은 서버도 종료하며, 그 `startServer`는 기동 중 종료 오류로 실패한다.
 * SIGINT 처리에서 서버 핸들이 없는 상태의 프로세스를 남기지 않으려고 쓴다.
 */
export async function stopAllServers(): Promise<number[]> {
  const servers = [...active];
  await Promise.all(servers.map(terminate));
  return servers.map((server) => server.proc.pid!);
}

/**
 * 빌드된 `apps/api/dist/main.js`를 별도 프로세스로 기동하고 `/health/ready`가 200이 될 때까지 기다린다.
 * 기동 중 프로세스가 종료하면 제한 시간을 기다리지 않고 로그 끝부분이 담긴 오류를 던진다.
 * 준비를 기다리다 실패하면(시간 초과 포함) 프로세스를 종료한 뒤 오류를 던진다.
 */
export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const logFile = path.join(options.workDir, `${options.label}.server.log`);
  let running: RunningServer | null = null;

  const stop = async (): Promise<void> => {
    const current = running;
    running = null;
    if (current !== null) await terminate(current);
  };

  const launch = async (): Promise<void> => {
    const logFd = openSync(logFile, 'a');
    const proc = spawn(process.execPath, [API_MAIN], {
      cwd: options.workDir,
      env: options.env,
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
    let exited = false;
    const exit = new Promise<void>((resolve) => {
      proc.once('exit', () => {
        exited = true;
        active.delete(server);
        resolve();
      });
    });
    const server: RunningServer = { proc, exit };
    active.add(server);
    running = server;
    try {
      // 프로세스가 종료했으면 확인을 끝내고 아래에서 오류로 바꾼다.
      await waitUntil(async () => exited || (await fetch(`${baseUrl}/health/ready`)).status === 200, {
        timeoutMs: 60_000,
        description: 'API 서버 준비',
      });
    } catch (error) {
      await stop();
      throw error;
    }
    if (exited) {
      throw new Error(`API 서버가 기동 중 종료했다(exit ${proc.exitCode}).\n${tail(logFile)}`);
    }
  };

  await launch();
  return {
    baseUrl,
    logFile,
    stop,
    async restart() {
      await stop();
      await launch();
    },
  };
}
