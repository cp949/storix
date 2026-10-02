import { spawnSync } from 'node:child_process';
import { databaseEnv } from '../infra/containers.ts';
import { assertExperimentDatabase, templateDatabaseName } from '../infra/guard.ts';
import { adminSql, createDatabase, execSql, queryOne } from '../infra/psql.ts';
import { REPO_ROOT } from '../paths.ts';
import { type DatasetSpec, expectedCounts, type ExpectedCounts } from './spec.ts';
import { ANALYZE_SQL, COUNT_SQL, activeChunkSql, chunkRanges, deletedChunkSql } from './sql.ts';

const CHUNK_SIZE = 50_000;

/** 빌드된 API의 migration을 `database`에 적용한다. */
export function migrate(database: string): void {
  assertExperimentDatabase(database);
  const result = spawnSync('pnpm', ['--filter', '@cp949/storix-api', 'run', 'migration:run:prod'], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...databaseEnv(database),
    },
    encoding: 'utf-8',
  });
  if (result.status !== 0) throw new Error(`migration 실패:\n${result.stdout}\n${result.stderr}`);
}

/** database에 붙여 둔 명세(COMMENT ON DATABASE)를 읽는다. 없으면 null이다. */
export function readDatasetSpec(database: string): DatasetSpec | null {
  assertExperimentDatabase(database);
  const text = adminSql(
    `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '${database}'`,
  ).trim();
  // 필드가 추가되기 전에 적재한 템플릿은 새 필드가 없다. 추가된 필드의 기본값(비활성)으로 채운다.
  return text === '' ? null : ({ blockedEvery: 0, ...JSON.parse(text) } as DatasetSpec);
}

/** 적재된 행 수를 읽는다. */
export async function readCounts(database: string): Promise<ExpectedCounts> {
  const raw = await queryOne<Record<string, string | number>>(database, COUNT_SQL);
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Number(value)]),
  ) as unknown as ExpectedCounts;
}

/** 기대 행 수와 실제 행 수의 차이를 문자열로 돌려준다. 같으면 빈 배열이다. */
export function diffCounts(expected: ExpectedCounts, actual: ExpectedCounts): string[] {
  return (Object.keys(expected) as Array<keyof ExpectedCounts>)
    .filter((key) => expected[key] !== actual[key])
    .map((key) => `${key}: 기대 ${expected[key]}, 실제 ${actual[key]}`);
}

/** 진행 로그 콜백. */
export type Progress = (message: string) => void;

/**
 * 템플릿 database를 새로 만들고 명세대로 적재한다.
 * 기존 같은 이름의 database는 지운다(실험 대상 이름일 때만).
 */
export async function seedTemplate(spec: DatasetSpec, progress: Progress): Promise<string> {
  const database = templateDatabaseName(spec.namespaces, spec.seed);
  createDatabase(database);
  progress(`database ${database} 생성, migration 적용`);
  migrate(database);

  const started = Date.now();
  const activeRanges = chunkRanges(spec.namespaces, CHUNK_SIZE);
  for (const [index, range] of activeRanges.entries()) {
    await execSql(database, activeChunkSql(spec, range));
    progress(
      `ACTIVE namespace ${range.to}/${spec.namespaces} (chunk ${index + 1}/${activeRanges.length}, ${Math.round((Date.now() - started) / 1000)}s)`,
    );
  }
  for (const range of chunkRanges(spec.deletedNamespaces, CHUNK_SIZE)) {
    await execSql(database, deletedChunkSql(spec, range));
    progress(`DELETED namespace ${range.to}/${spec.deletedNamespaces}`);
  }
  progress('ANALYZE');
  await execSql(database, ANALYZE_SQL);

  const diff = diffCounts(expectedCounts(spec), await readCounts(database));
  if (diff.length > 0) throw new Error(`적재 행 수가 명세와 다르다:\n${diff.join('\n')}`);

  const comment = JSON.stringify(spec).replaceAll("'", "''");
  adminSql(`COMMENT ON DATABASE ${database} IS '${comment}'`);
  progress(`적재 완료: ${Math.round((Date.now() - started) / 1000)}s`);
  return database;
}
