import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { WORK_DIR } from '../paths.ts';
import { run } from './exec.ts';
import { POSTGRES_CONTAINER, STORAGE_CONTAINER, assertExperimentContainer } from './guard.ts';

const PG_IMAGE = 'postgres:16-alpine';
const VGW_IMAGE = 'versity/versitygw:v1.8.0';
export const PG_USER = 'storix';
export const PG_PASSWORD = 'storix';
export const STORAGE_ACCESS_KEY = 'storix';
export const STORAGE_SECRET_KEY = 'storix-secret';
export const STORAGE_BUCKET = 'storix';

/** VersityGW posix 백엔드의 데이터 디렉터리(호스트). bucket은 이 아래 최상위 디렉터리다. */
export const STORAGE_DATA_DIR = path.join(WORK_DIR, 'vgw-data');

/** bucket 디렉터리(호스트). 데이터셋의 object 파일을 직접 만들고 지운다. */
export const STORAGE_BUCKET_DIR = path.join(STORAGE_DATA_DIR, STORAGE_BUCKET);

/** 호스트에 공개하는 PostgreSQL 포트. `STORIX_SCALE_PG_PORT`로 바꾼다. */
export function postgresPort(): number {
  return Number(process.env.STORIX_SCALE_PG_PORT ?? 55433);
}

/** 호스트에 공개하는 VersityGW 포트. `STORIX_SCALE_VGW_PORT`로 바꾼다. */
export function storagePort(): number {
  return Number(process.env.STORIX_SCALE_VGW_PORT ?? 57070);
}

/** PostgreSQL 서버 설정. 측정 환경 기록에 그대로 남긴다. */
export const POSTGRES_SETTINGS = [
  'shared_buffers=2GB',
  'max_wal_size=16GB',
  'checkpoint_timeout=30min',
  'maintenance_work_mem=1GB',
  'max_connections=200',
] as const;

function containerState(name: string): 'running' | 'stopped' | 'absent' {
  assertExperimentContainer(name);
  const out = run('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}']).trim();
  if (out === '') return 'absent';
  return out === 'running' ? 'running' : 'stopped';
}

/** 전용 PostgreSQL을 기동한다(이미 있으면 재사용). 데이터는 named volume에 남는다. */
export function ensurePostgres(): void {
  const state = containerState(POSTGRES_CONTAINER);
  if (state === 'running') return;
  if (state === 'stopped') {
    run('docker', ['start', POSTGRES_CONTAINER]);
    return;
  }
  run('docker', [
    'run',
    '-d',
    '--name',
    POSTGRES_CONTAINER,
    '--shm-size=2g',
    '-p',
    `127.0.0.1:${postgresPort()}:5432`,
    '-v',
    'storix-scale-pgdata:/var/lib/postgresql/data',
    '-e',
    `POSTGRES_USER=${PG_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    PG_IMAGE,
    ...POSTGRES_SETTINGS.flatMap((setting) => ['-c', setting]),
  ]);
}

/** 전용 VersityGW를 기동한다(이미 있으면 재사용). bucket은 posix 백엔드의 최상위 디렉터리다. */
export function ensureStorage(): void {
  const state = containerState(STORAGE_CONTAINER);
  if (state === 'running') return;
  if (state === 'stopped') {
    run('docker', ['start', STORAGE_CONTAINER]);
    return;
  }
  // object 파일을 호스트에서 직접 만들 수 있도록 bind mount한다. bucket은 posix 백엔드의 최상위 디렉터리다.
  mkdirSync(STORAGE_BUCKET_DIR, { recursive: true });
  run('docker', [
    'run',
    '-d',
    '--name',
    STORAGE_CONTAINER,
    '-v',
    `${STORAGE_DATA_DIR}:/data`,
    '-p',
    `127.0.0.1:${storagePort()}:7070`,
    '-e',
    `ROOT_ACCESS_KEY=${STORAGE_ACCESS_KEY}`,
    '-e',
    `ROOT_SECRET_KEY=${STORAGE_SECRET_KEY}`,
    '-e',
    'VGW_BACKEND=posix',
    '-e',
    'VGW_BACKEND_ARGS=/data',
    '-e',
    'VGW_ARGS=--health /health',
    VGW_IMAGE,
  ]);
}

/** 컨테이너를 제거한다. `--volumes`면 데이터 volume도 지운다(seed 결과가 사라진다). */
export function removeContainers(volumes: boolean): void {
  for (const name of [POSTGRES_CONTAINER, STORAGE_CONTAINER]) {
    assertExperimentContainer(name);
    if (containerState(name) !== 'absent') run('docker', ['rm', '-f', name]);
  }
  if (volumes) {
    for (const volume of ['storix-scale-pgdata']) {
      try {
        run('docker', ['volume', 'rm', volume]);
      } catch {
        // volume이 없으면 지울 것이 없다.
      }
    }
  }
}

/** API·GC 프로세스에 전달하는 `STORIX_STORAGE_*`. */
export function storageEnv(): Record<string, string> {
  return {
    STORIX_STORAGE_ENDPOINT: '127.0.0.1',
    STORIX_STORAGE_PORT: String(storagePort()),
    STORIX_STORAGE_USE_SSL: 'false',
    STORIX_STORAGE_ACCESS_KEY: STORAGE_ACCESS_KEY,
    STORIX_STORAGE_SECRET_KEY: STORAGE_SECRET_KEY,
    STORIX_STORAGE_BUCKET: STORAGE_BUCKET,
    STORIX_STORAGE_PATH_STYLE: 'true',
  };
}

/** API·GC 프로세스에 전달하는 `STORIX_DB_*`. */
export function databaseEnv(database: string): Record<string, string> {
  return {
    STORIX_DB_DRIVER: 'postgres',
    STORIX_DB_HOST: '127.0.0.1',
    STORIX_DB_PORT: String(postgresPort()),
    STORIX_DB_USERNAME: PG_USER,
    STORIX_DB_PASSWORD: PG_PASSWORD,
    STORIX_DB_NAME: database,
  };
}
