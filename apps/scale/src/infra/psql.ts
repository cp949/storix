import { PG_USER } from './containers.ts';
import { run, runAsync } from './exec.ts';
import { POSTGRES_CONTAINER, assertExperimentDatabase } from './guard.ts';

function args(database: string): string[] {
  return [
    'exec',
    '-i',
    POSTGRES_CONTAINER,
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    PG_USER,
    '-d',
    database,
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
  ];
}

/** 관리용 database(`postgres`)에서 실행한다. database 생성·삭제에만 쓴다. */
export function adminSql(sql: string): string {
  return run('docker', [...args('postgres'), '-t', '-A', '-c', sql]);
}

/** 실험 database에 SQL을 stdin으로 전달한다. */
export function execSql(database: string, sql: string): Promise<string> {
  assertExperimentDatabase(database);
  return runAsync('docker', args(database), sql);
}

/** 단일 행 JSON 결과를 돌려준다. SQL은 `SELECT row_to_json(...)` 형태여야 한다. */
export async function queryOne<T>(database: string, sql: string): Promise<T> {
  assertExperimentDatabase(database);
  const out = await runAsync(
    'docker',
    [...args(database), '-t', '-A'],
    `SELECT row_to_json(q) FROM (${sql}) q;`,
  );
  return JSON.parse(out.trim()) as T;
}

/** 여러 행 JSON 결과를 돌려준다. */
export async function queryAll<T>(database: string, sql: string): Promise<T[]> {
  assertExperimentDatabase(database);
  const out = await runAsync(
    'docker',
    [...args(database), '-t', '-A'],
    `SELECT row_to_json(q) FROM (${sql}) q;`,
  );
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

/** database 존재 여부. */
export function databaseExists(name: string): boolean {
  assertExperimentDatabase(name);
  return adminSql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`).trim() === '1';
}

/** database를 지운다(실험 대상만). 접속 중인 세션은 끊는다. */
export function dropDatabase(name: string): void {
  assertExperimentDatabase(name);
  adminSql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  );
  adminSql(`DROP DATABASE IF EXISTS ${name}`);
}

/** `template`에서 database를 복제한다(복원). 이름은 모두 실험 대상이어야 한다. */
export function cloneDatabase(template: string, name: string): void {
  assertExperimentDatabase(template);
  assertExperimentDatabase(name);
  dropDatabase(name);
  adminSql(`CREATE DATABASE ${name} TEMPLATE ${template} STRATEGY FILE_COPY`);
}

/** 빈 database를 만든다. */
export function createDatabase(name: string): void {
  assertExperimentDatabase(name);
  dropDatabase(name);
  adminSql(`CREATE DATABASE ${name}`);
}
