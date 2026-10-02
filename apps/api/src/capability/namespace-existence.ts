import type { DataSource } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';

// SQLite 변수 제한(구버전 999)을 피하려고 id를 청크로 나눈다. PostgreSQL은 배열 파라미터 하나로 조회한다.
const SQLITE_CHUNK_SIZE = 1000;

/**
 * `ids` 중 namespace 행이 없는 id를 입력 순서대로 돌려준다(상태는 보지 않는다).
 * 질의 수는 id 수와 무관한 상수(PostgreSQL 1회)이거나 `ceil(n / 1000)`회(SQLite)다.
 */
export async function findMissingNamespaceIds(
  dataSource: Pick<DataSource, 'options' | 'query'>,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = new Set<string>();
  if (isSqliteDataSource(dataSource.options)) {
    for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
      const rows = (await dataSource.query(
        `SELECT id FROM namespace WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      )) as Array<{ id: string }>;
      for (const row of rows) found.add(row.id);
    }
  } else {
    const rows = (await dataSource.query('SELECT id FROM namespace WHERE id = ANY($1::varchar[])', [
      [...ids],
    ])) as Array<{ id: string }>;
    for (const row of rows) found.add(row.id);
  }
  return ids.filter((id) => !found.has(id));
}
