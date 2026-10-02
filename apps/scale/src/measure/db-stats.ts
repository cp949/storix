import { queryAll, queryOne } from '../infra/psql.ts';

/** `pg_stat_database` 누적값. 단계 전후의 차이로 DB 실행량을 본다. */
export interface DbCounters {
  readonly xactCommit: number;
  readonly blksRead: number;
  readonly blksHit: number;
  readonly tupReturned: number;
  readonly tupFetched: number;
  readonly tupInserted: number;
  readonly tupUpdated: number;
  readonly tupDeleted: number;
}

/** 현재 누적값을 읽는다. 통계 반영 지연을 피하려고 잠시 기다린다. */
export async function readDbCounters(database: string): Promise<DbCounters> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const row = await queryOne<Record<string, string | number>>(
    database,
    `SELECT xact_commit, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted
     FROM pg_stat_database WHERE datname = '${database}'`,
  );
  return {
    xactCommit: Number(row.xact_commit),
    blksRead: Number(row.blks_read),
    blksHit: Number(row.blks_hit),
    tupReturned: Number(row.tup_returned),
    tupFetched: Number(row.tup_fetched),
    tupInserted: Number(row.tup_inserted),
    tupUpdated: Number(row.tup_updated),
    tupDeleted: Number(row.tup_deleted),
  };
}

/** 두 누적값의 차이. */
export function diffCounters(before: DbCounters, after: DbCounters): DbCounters {
  const keys = Object.keys(before) as Array<keyof DbCounters>;
  return Object.fromEntries(keys.map((key) => [key, after[key] - before[key]])) as unknown as DbCounters;
}

/** 테이블·인덱스 크기(바이트). */
export interface RelationSize {
  readonly table: string;
  readonly tableBytes: number;
  readonly indexBytes: number;
}

const SIZE_TABLES = [
  'namespace',
  'vfs_node',
  'blob',
  'idempotency_key',
  'vfs_change_event',
  'vfs_change_feed_state',
  'namespace_deletion',
  'namespace_deletion_receipt',
];

/** 주요 테이블과 인덱스 크기를 읽는다. */
export async function readRelationSizes(database: string): Promise<RelationSize[]> {
  const rows = await queryAll<{
    table: string;
    table_bytes: string;
    index_bytes: string;
  }>(
    database,
    `SELECT t AS "table", pg_table_size(t::regclass) AS table_bytes, pg_indexes_size(t::regclass) AS index_bytes
     FROM unnest(ARRAY[${SIZE_TABLES.map((t) => `'${t}'`).join(',')}]) AS t`,
  );
  return rows.map((row) => ({
    table: row.table,
    tableBytes: Number(row.table_bytes),
    indexBytes: Number(row.index_bytes),
  }));
}
