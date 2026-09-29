import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './paths.ts';

/** 준비한 DB. */
export interface DatabaseHandle {
  /** API 서버에 전달할 `STORIX_DB_*` */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * `workDir` 아래에 새 SQLite 파일을 만들고 빌드된 API의 migration을 적용한다.
 * 프로필마다 파일을 새로 만들어 상태를 초기화한다.
 */
export function prepareSqliteDatabase(workDir: string, label: string): DatabaseHandle {
  const env = {
    STORIX_DB_DRIVER: 'sqlite',
    STORIX_DB_SQLITE_PATH: path.join(workDir, `${label}.sqlite`),
  };
  const result = spawnSync('pnpm', ['--filter', '@cp949/storix-api', 'run', 'migration:run:prod'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`SQLite migration 실패:\n${result.stdout}\n${result.stderr}`);
  }
  return { env };
}
