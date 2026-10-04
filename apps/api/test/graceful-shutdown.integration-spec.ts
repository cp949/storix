/** 실제 서버 프로세스의 종료 신호·요청 대기·시간 초과 동작을 SQLite 환경에서 검증한다. 규칙은 api ADR-0043이다. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiRoot, buildApp, runMigrations, stripSecretEnv } from './boot-env-file-harness.js';

// 실제 배포 진입점(`node dist/main.js`)을 자식 프로세스로 띄워 SIGTERM·SIGINT 종료 동작을 검증한다.
// 같은 jest 워커 안에서는 process.exit와 신호 핸들러를 실제로 확인할 수 없다.
// 환경은 SQLite 파일 DB와 도달하지 않는 스토리지 엔드포인트다. 부팅과 종료만 확인하므로 스토리지에 접속하지 않는다.
// 진행 중 요청은 본문을 일부만 보낸 JSON POST로 만든다. body-parser가 본문을 다 받을 때까지 요청이 서버에 머문다.
// 규칙은 api ADR-0043.

interface Server {
  readonly child: ChildProcess;
  readonly port: number;
  readonly exited: Promise<number | null>;
  output(): string;
}

/** 자식 서버가 사용할 임시 TCP 포트를 찾는다. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** SQLite 서버를 자식 프로세스로 띄우고 포트가 열릴 때까지 기다린다. */
async function startServer(sqlitePath: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Server> {
  const port = await findFreePort();
  const child = spawn('node', [path.join(apiRoot, 'dist', 'main.js')], {
    cwd: apiRoot,
    env: {
      ...stripSecretEnv(process.env),
      STORIX_DB_DRIVER: 'sqlite',
      STORIX_DB_SQLITE_PATH: sqlitePath,
      STORIX_API_KEY: 'test-key-0123456789',
      STORIX_STORAGE_ENDPOINT: '127.0.0.1',
      STORIX_STORAGE_PORT: '1',
      STORIX_STORAGE_ACCESS_KEY: 'test-access',
      STORIX_STORAGE_SECRET_KEY: 'test-secret',
      STORIX_STORAGE_BUCKET: 'test-bucket',
      STORIX_PORT: String(port),
      ...extraEnv,
    },
  });

  let output = '';
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`부팅 타임아웃. 출력:\n${output}`)), 20000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Nest application successfully started')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`부팅 중 종료(exit ${code}). 출력:\n${output}`));
    });
  });

  // 부팅 로그 직후에는 포트가 아직 연결을 받지 못하는 경우가 있어 실제로 열릴 때까지 기다린다.
  await waitUntilPortOpen(port);

  return { child, port, exited, output: () => output };
}

/** 본문을 일부만 보낸 상태로 요청을 열어 두는 핸들이다. */
interface OpenRequest {
  /** 남은 본문을 보내고 응답 상태 코드를 기다린다. 응답 전에 연결이 끊기면 거부한다. */
  finish(): Promise<number>;

  /** 연결이 끊겨 요청이 실패하면 해당 오류로 이행한다. */
  failed: Promise<Error>;
}

/** 본문 절반을 보내 요청을 진행 중인 상태로 유지한다. */
async function openRequest(port: number): Promise<OpenRequest> {
  const body = '{"padding":"xxxxxxxxxxxxxxxxxxxx"}';
  const half = body.length / 2;
  let req!: http.ClientRequest;
  const response = new Promise<number>((resolve, reject) => {
    req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/graceful-shutdown-probe',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, half));
  });
  // 서버가 헤더와 앞부분 본문을 받아 요청이 진행 중이 될 때까지 짧게 기다린다.
  await new Promise((resolve) => setTimeout(resolve, 300));

  return {
    finish: () => {
      req.end(body.slice(half));
      return response;
    },
    failed: response.then(
      () => new Promise<Error>(() => undefined),
      (error: Error) => error,
    ),
  };
}

/** TCP 연결이 거부되는지 확인한다. */
async function isPortRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

/** 서버가 포트를 열 때까지 기다린다. */
async function waitUntilPortOpen(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortRefused(port))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('부팅 로그 뒤에도 포트가 열리지 않는다');
}

/** 종료 신호 뒤 서버가 새 연결을 거부할 때까지 기다린다. */
async function waitUntilPortRefused(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortRefused(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('SIGTERM 뒤에도 새 연결을 계속 받는다');
}

describe('API 서버 종료 (SIGTERM·SIGINT)', () => {
  let workDir: string;
  let sqlitePath: string;
  let server: Server | undefined;

  beforeAll(() => {
    buildApp();
  }, 60000);

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'storix-shutdown-'));
    sqlitePath = path.join(workDir, 'storix.sqlite');
    runMigrations(sqlitePath);
    server = undefined;
  });

  afterEach(() => {
    server?.child.kill('SIGKILL');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('유휴 상태에서 SIGTERM을 받으면 exit 0으로 종료하고 새 연결을 받지 않는다', async () => {
    server = await startServer(sqlitePath);

    server.child.kill('SIGTERM');

    await expect(server.exited).resolves.toBe(0);
    await expect(isPortRefused(server.port)).resolves.toBe(true);
  }, 40000);

  it('SIGINT도 exit 0으로 종료한다', async () => {
    server = await startServer(sqlitePath);

    server.child.kill('SIGINT');

    await expect(server.exited).resolves.toBe(0);
  }, 40000);

  it('진행 중 요청은 SIGTERM 뒤에도 응답을 받고 그 뒤에 exit 0으로 종료한다', async () => {
    server = await startServer(sqlitePath);
    const open = await openRequest(server.port);

    server.child.kill('SIGTERM');
    await waitUntilPortRefused(server.port);
    // 새 연결은 막혔지만 프로세스는 진행 중 요청 때문에 아직 살아 있어야 한다.
    expect(server.child.exitCode).toBeNull();
    const status = await open.finish();

    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(600);
    await expect(server.exited).resolves.toBe(0);
  }, 40000);

  it('STORIX_SHUTDOWN_TIMEOUT_SECONDS를 넘기면 연결을 끊고 exit 1로 종료한다', async () => {
    server = await startServer(sqlitePath, { STORIX_SHUTDOWN_TIMEOUT_SECONDS: '1' });
    const open = await openRequest(server.port);
    const startedAt = Date.now();

    server.child.kill('SIGTERM');
    await expect(server.exited).resolves.toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    await expect(open.failed).resolves.toMatchObject({
      message: expect.stringMatching(/socket hang up|ECONNRESET/),
    });
    expect(server.output()).toContain('종료 대기 1초 초과');
  }, 40000);

  it('종료 중 두 번째 신호를 받으면 상한을 기다리지 않고 exit 1로 종료한다', async () => {
    server = await startServer(sqlitePath, { STORIX_SHUTDOWN_TIMEOUT_SECONDS: '60' });
    await openRequest(server.port);
    const startedAt = Date.now();

    server.child.kill('SIGTERM');
    await waitUntilPortRefused(server.port);
    server.child.kill('SIGINT');

    await expect(server.exited).resolves.toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(10000);
  }, 40000);

  it('STORIX_SHUTDOWN_TIMEOUT_SECONDS가 잘못되면 부팅을 거부한다', async () => {
    await expect(startServer(sqlitePath, { STORIX_SHUTDOWN_TIMEOUT_SECONDS: '0' })).rejects.toThrow(
      '잘못된 정수 환경변수 값',
    );
  }, 40000);
});
