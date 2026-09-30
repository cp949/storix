import { execFileSync } from 'node:child_process';
import { CONTAINER_PREFIX } from './blob-storage.ts';
import { cleanupError, ExecutionCleanupError, runCleanupCommand } from './cleanup.ts';
import { runMigrations, type DatabaseHandle } from './database.ts';
import { waitUntil } from './wait.ts';

const IMAGE = 'postgres:16-alpine';
const USER = 'storix';
const PASSWORD = 'storix';

/** 기동한 Postgres. */
export interface PostgresHandle {
  /** 컨테이너 이름 */
  readonly container: string;

  /** 호스트에서 접속하는 `127.0.0.1` 포트 */
  readonly port: number;

  /** 컨테이너를 제거한다. */
  stop(): Promise<void>;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8' }).trim();
}

/** 실행 ID와 프로필로 database 이름을 만든다. 소문자·숫자·밑줄만 남겨 따옴표 없이 쓸 수 있게 한다. */
export function postgresDatabaseName(runId: string, profile: string): string {
  return `storix_${runId}_${profile}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** API 서버와 migration에 전달할 `STORIX_DB_*`를 만든다. */
export function buildPostgresEnv(port: number, database: string): Record<string, string> {
  return {
    STORIX_DB_DRIVER: 'postgres',
    STORIX_DB_HOST: '127.0.0.1',
    STORIX_DB_PORT: String(port),
    STORIX_DB_USERNAME: USER,
    STORIX_DB_PASSWORD: PASSWORD,
    STORIX_DB_NAME: database,
  };
}

/**
 * Postgres 컨테이너를 기동하고 접속을 받을 때까지 기다린다. 호스트 포트는 `127.0.0.1`의 임의 포트다.
 * 이전 실행의 잔여 컨테이너는 지우지 않는다. `startBlobStorage`가 `storix-contract-` 접두어를 모두 지우므로
 * 그 뒤에 호출해야 방금 띄운 컨테이너가 남는다.
 */
export async function startPostgres(runId: string): Promise<PostgresHandle> {
  const container = `${CONTAINER_PREFIX}pg-${runId}`;
  docker([
    'run',
    '-d',
    '--name',
    container,
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_USER=${USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PASSWORD}`,
    IMAGE,
  ]);
  const stop = async (): Promise<void> => {
    await runCleanupCommand('docker', ['rm', '-f', '-v', container]);
  };
  try {
    const port = Number(/:(\d+)$/m.exec(docker(['port', container, '5432/tcp']))![1]);
    // 초기화 중에는 임시 서버가 unix socket으로만 응답하므로 TCP 접속으로 최종 기동을 확인한다.
    await waitUntil(
      async () => {
        execFileSync(
          'docker',
          ['exec', container, 'psql', '-h', '127.0.0.1', '-U', USER, '-d', 'postgres', '-c', 'select 1'],
          { stdio: 'ignore' },
        );
        return true;
      },
      { timeoutMs: 60_000, description: 'Postgres 준비' },
    );
    return { container, port, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new ExecutionCleanupError(error, [cleanupError(cleanup)]);
    }
    throw error;
  }
}

/** 프로필마다 새 database를 만들고 빌드된 API의 migration을 적용한다. */
export function preparePostgresDatabase(
  postgres: PostgresHandle,
  runId: string,
  profile: string,
): DatabaseHandle {
  const name = postgresDatabaseName(runId, profile);
  docker(['exec', postgres.container, 'createdb', '-h', '127.0.0.1', '-U', USER, name]);
  const env = buildPostgresEnv(postgres.port, name);
  runMigrations(env, 'Postgres');
  return { env };
}
