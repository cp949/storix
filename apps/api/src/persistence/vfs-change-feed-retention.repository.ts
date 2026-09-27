import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { VfsChangeEventEntity } from './entities/vfs-change-event.entity.js';
import { VfsChangeFeedStateEntity } from './entities/vfs-change-feed-state.entity.js';
import { readChangeFeedState } from './vfs-change-feed-journal.js';

export function resolveChangeFeedRetentionDays(value: string | undefined): number {
  if (value === undefined) return 30;
  if (!/^[1-9][0-9]*$/.test(value))
    throw new Error('STORIX_VFS_CHANGE_RETENTION_DAYS는 양의 정수여야 합니다');
  const days = Number(value);
  if (!Number.isSafeInteger(days))
    throw new Error('STORIX_VFS_CHANGE_RETENTION_DAYS는 안전한 정수여야 합니다');
  return days;
}

@Injectable()
export class VfsChangeFeedRetentionRepository {
  constructor(private readonly dataSource: DataSource) {}

  // 한 namespace의 가장 오래된 연속 이벤트만 삭제한다. 뒤쪽 이벤트가 먼저
  // 만료되어도 그 앞의 유효 이벤트를 cursor 경계로 넘어가지 않는다.
  async pruneExpiredBatch(days: number, batchSize: number): Promise<number> {
    if (
      !Number.isSafeInteger(days) ||
      days < 1 ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 500
    )
      throw new Error('Invalid change feed prune arguments');
    const sqlite = isSqliteDataSource(this.dataSource.options);
    return this.dataSource.transaction(async (manager) => {
      const cutoffRows = (await manager.query(
        sqlite
          ? `SELECT datetime('now', '-' || ? || ' days') AS cutoff`
          : `SELECT (CURRENT_TIMESTAMP - ($1::double precision * INTERVAL '1 day'))::text AS cutoff`,
        [days],
      )) as Array<{ cutoff: string }>;
      const cutoff = cutoffRows[0].cutoff;
      const candidateRows = (await manager.query(
        sqlite
          ? `SELECT s.namespace_id FROM vfs_change_feed_state s
         JOIN vfs_change_event e ON e.namespace_id = s.namespace_id
           AND e.sequence = (SELECT MIN(first_event.sequence) FROM vfs_change_event first_event
             WHERE first_event.namespace_id = s.namespace_id)
         WHERE e.occurred_at < ? ORDER BY e.occurred_at, s.namespace_id LIMIT 1`
          : `SELECT s.namespace_id FROM vfs_change_feed_state s
         JOIN vfs_change_event e ON e.namespace_id = s.namespace_id
           AND e.sequence = (SELECT MIN(first_event.sequence) FROM vfs_change_event first_event
             WHERE first_event.namespace_id = s.namespace_id)
         WHERE e.occurred_at < $1 ORDER BY e.occurred_at, s.namespace_id LIMIT 1
         FOR UPDATE OF s SKIP LOCKED`,
        [cutoff],
      )) as Array<{ namespace_id: string }>;
      const namespaceId = candidateRows[0]?.namespace_id;
      if (!namespaceId) return 0;
      const state = await readChangeFeedState(manager, namespaceId, sqlite);
      if (!state) throw new Error('Change feed state disappeared during prune');
      const rows = (await manager.query(
        sqlite
          ? `SELECT CAST(e.sequence AS TEXT) AS sequence, e.occurred_at < ? AS expired
         FROM vfs_change_event e WHERE e.namespace_id = ? ORDER BY e.sequence ASC LIMIT ?`
          : `SELECT CAST(e.sequence AS TEXT) AS sequence, e.occurred_at < $1 AS expired
         FROM vfs_change_event e WHERE e.namespace_id = $2 ORDER BY e.sequence ASC LIMIT $3`,
        [cutoff, namespaceId, batchSize],
      )) as Array<{ sequence: string; expired: boolean | number }>;
      const expired: string[] = [];
      for (const row of rows) {
        if (!row.expired) break;
        expired.push(row.sequence);
      }
      if (expired.length === 0) return 0;
      const last = expired[expired.length - 1];
      if (BigInt(last) > BigInt(state.lastSequence) || BigInt(last) < BigInt(state.prunedThrough))
        throw new Error('Invalid change feed prune boundary');
      const deleted = await manager
        .getRepository(VfsChangeEventEntity)
        .delete({ namespaceId, sequence: In(expired) });
      if (deleted.affected !== expired.length) throw new Error('Change feed prune count mismatch');
      await manager.getRepository(VfsChangeFeedStateEntity).update({ namespaceId }, { prunedThrough: last });
      return expired.length;
    });
  }
}
