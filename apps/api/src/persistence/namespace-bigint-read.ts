import type { EntityManager } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import type { NamespaceEntity } from './entities/namespace.entity.js';
import { classifyPersistenceFailure } from './persistence-failure.js';

// 오래된 SQLite의 999개 변수 제한과 PostgreSQL의 바인딩 제한 모두에 여유를 둔다.
const ID_BATCH_SIZE = 900;

interface ExactNamespaceCounters {
  id: string;
  maxTotalLogicalBytes: string | null;
  liveFileByteCount: string;
  retainedSnapshotByteCount: string;
  retainedTrashByteCount: string;
  retainedTrashNodeCount: string;
}

// SQLite INTEGER를 JS number로 읽기 전에 TEXT로 변환해 int64 값을 보존한다.
export async function withExactNamespaceBigints(
  manager: EntityManager,
  namespaces: readonly NamespaceEntity[],
): Promise<NamespaceEntity[]> {
  if (namespaces.length === 0) return [];
  const exact = new Map<string, ExactNamespaceCounters>();
  for (let start = 0; start < namespaces.length; start += ID_BATCH_SIZE) {
    const ph = new DialectPlaceholders(isSqliteDataSource(manager.connection.options));
    const ids = namespaces.slice(start, start + ID_BATCH_SIZE).map((namespace) => ph.bind(namespace.id)).join(', ');
    let rows: ExactNamespaceCounters[];
    try {
      rows = await manager.query(`SELECT id,
    CAST(max_total_logical_bytes AS TEXT) AS "maxTotalLogicalBytes",
    CAST(live_file_byte_count AS TEXT) AS "liveFileByteCount",
    CAST(retained_snapshot_byte_count AS TEXT) AS "retainedSnapshotByteCount",
    CAST(retained_trash_byte_count AS TEXT) AS "retainedTrashByteCount",
    CAST(retained_trash_node_count AS TEXT) AS "retainedTrashNodeCount"
    FROM namespace WHERE id IN (${ids})`, ph.params) as ExactNamespaceCounters[];
    } catch (error) {
      throw classifyPersistenceFailure(error) ?? error;
    }
    for (const row of rows) exact.set(row.id, row);
  }
  return namespaces.map((namespace) => {
    const row = exact.get(namespace.id);
    if (!row) throw new Error('Namespace counters missing');
    return { ...namespace, ...row };
  });
}
