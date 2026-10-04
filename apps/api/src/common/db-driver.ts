import type { DataSourceOptions } from 'typeorm';

export type DbDriver = 'postgres' | 'sqlite';

/**
 * DB 드라이버를 판정한다. 인자가 없으면 `STORIX_DB_DRIVER`를 읽는다.
 *
 * - 값이 없거나 빈 문자열이면 `postgres`다.
 * - `postgres`·`sqlite`는 그대로 돌려준다.
 * - 그 밖의 값은 오타로 보고 일반 `Error`를 던진다. 대소문자와 공백은 바꾸지 않는다.
 *
 * 엔티티의 컬럼 타입 상수가 import 시점에 호출하므로 진입점마다 한 번은 검증된다.
 * 규칙은 docs/design/01-db-driver-portability.md "드라이버 선택".
 */
export function getDbDriver(driver?: string): DbDriver {
  const value = driver ?? process.env.STORIX_DB_DRIVER;
  if (value === undefined || value === '' || value === 'postgres') {
    return 'postgres';
  }
  if (value === 'sqlite') {
    return 'sqlite';
  }
  throw new Error(`STORIX_DB_DRIVER는 postgres 또는 sqlite여야 한다: ${JSON.stringify(value)}`);
}

export function isSqliteDataSource(options: DataSourceOptions): boolean {
  return options.type === 'better-sqlite3';
}
