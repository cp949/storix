import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { VfsChangeEventEntity } from './entities/vfs-change-event.entity.js';
import { VfsChangeFeedStateEntity } from './entities/vfs-change-feed-state.entity.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
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

/**
 * 보존 정리의 재개 위치. 만료 이벤트를 `idx_vfs_change_event_occurred_at`
 * `(occurred_at, namespace_id, sequence)` 순서로 훑을 때 마지막으로 처리한 이벤트다.
 * `occurredAt`은 DB가 돌려준 문자열을 그대로 쓴다(마이크로초·오프셋 보존).
 */
export interface ChangeFeedPruneCursor {
  readonly occurredAt: string;
  readonly namespaceId: string;
  readonly sequence: string;
}

export interface ChangeFeedPruneResult {
  /** 삭제한 이벤트 수 */
  readonly deleted: number;

  /** 이번 호출이 읽은 만료 이벤트 수. GC 단계 예산을 소모하는 단위다. */
  readonly examined: number;

  /** 예상 밖 오류로 정리하지 못한 namespace 수다. namespace별 원인은 error 로그에 남는다. */
  readonly failed: number;

  /** 이어 호출할 위치. null이면 cursor 뒤에 만료 이벤트가 더 없다. */
  readonly next: ChangeFeedPruneCursor | null;
}

const PAGE_LIMIT = 500;

interface ExpiredRow {
  readonly namespace_id: string;
  readonly sequence: string;
  readonly occurred_at: string;
  readonly is_head: boolean | number;
}

@Injectable()
export class VfsChangeFeedRetentionRepository {
  private readonly logger = new Logger(VfsChangeFeedRetentionRepository.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * cursor 뒤의 만료 이벤트 한 page(`scanLimit`행)를 읽고, 선두 이벤트인 namespace마다 만료된 연속
   * prefix를 최대 `batchSize`개씩 삭제한다(namespace마다 별도 트랜잭션). 뒤쪽 이벤트가 먼저 만료돼도
   * 그 앞의 유효 이벤트를 cursor 경계로 넘어가지 않는다. 선두가 유효한 namespace의 만료 이벤트는
   * 건너뛰며, cursor가 전진하므로 같은 실행 안에서 다시 읽지 않는다. prefix가 `batchSize`보다 길어
   * 남은 이벤트가 있으면 그 namespace에서 멈추고 cursor를 그 위치에 둔다.
   * 후보 선택은 만료 이벤트 인덱스 범위 스캔이라 비용이 전체 namespace 수가 아니라 읽은 만료
   * 이벤트 수에 비례한다.
   * 불변식 위반 같은 예상 밖 오류는 그 namespace만 롤백하고 실패로 집계한 뒤 다음 후보로 넘어간다.
   */
  async pruneNext(
    days: number,
    batchSize: number,
    after: ChangeFeedPruneCursor | null,
    scanLimit = PAGE_LIMIT,
  ): Promise<ChangeFeedPruneResult> {
    if (
      !Number.isSafeInteger(days) ||
      days < 1 ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 500 ||
      !Number.isSafeInteger(scanLimit) ||
      scanLimit < 1 ||
      scanLimit > PAGE_LIMIT
    )
      throw new Error('Invalid change feed prune arguments');
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const cutoffRows = (await this.dataSource.query(
      sqlite
        ? `SELECT datetime('now', '-' || ? || ' days') AS cutoff`
        : `SELECT (CURRENT_TIMESTAMP - ($1::double precision * INTERVAL '1 day'))::text AS cutoff`,
      [days],
    )) as Array<{ cutoff: string }>;
    const cutoff = cutoffRows[0].cutoff;
    const ph = new DialectPlaceholders(sqlite);
    const cutoffBind = ph.bind(cutoff);
    const afterClause = after
      ? `AND (e.occurred_at, e.namespace_id, e.sequence) > (${ph.bind(after.occurredAt)}${sqlite ? '' : '::timestamptz'}, ${ph.bind(after.namespaceId)}, ${ph.bind(after.sequence)}${sqlite ? '' : '::bigint'})`
      : '';
    const limitBind = ph.bind(scanLimit);
    const page = (await this.dataSource.query(
      `SELECT e.namespace_id AS namespace_id, CAST(e.sequence AS TEXT) AS sequence,
           ${sqlite ? 'e.occurred_at' : 'e.occurred_at::text'} AS occurred_at,
           NOT EXISTS (SELECT 1 FROM vfs_change_event f
             WHERE f.namespace_id = e.namespace_id AND f.sequence < e.sequence) AS is_head
         FROM vfs_change_event e
         WHERE e.occurred_at < ${sqlite ? cutoffBind : `${cutoffBind}::timestamptz`} ${afterClause}
         ORDER BY e.occurred_at, e.namespace_id, e.sequence LIMIT ${limitBind}`,
      ph.params,
    )) as ExpiredRow[];
    if (page.length === 0) return { deleted: 0, examined: 0, failed: 0, next: null };

    const cursorOf = (row: ExpiredRow): ChangeFeedPruneCursor => ({
      occurredAt: row.occurred_at,
      namespaceId: row.namespace_id,
      sequence: row.sequence,
    });
    let total = 0;
    let failed = 0;
    for (const [index, row] of page.entries()) {
      if (!row.is_head) continue;
      let deleted: number | null;
      try {
        deleted = await this.dataSource.transaction((manager) =>
          this.pruneNamespacePrefix(manager, sqlite, row.namespace_id, cutoff, batchSize),
        );
      } catch (error) {
        // 다시 던지면 GC 실행 전체가 실패한다. cursor가 저장되지 않아 다음 실행도 같은 namespace에서
        // 멈추므로, 뒤쪽 namespace와 뒤 단계(휴지통 정리)가 계속 막힌다.
        failed++;
        this.logger.error(
          `change feed 보존 정리 실패 namespace=${row.namespace_id}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        continue;
      }
      if (deleted === null) continue;
      total += deleted;
      if (deleted >= batchSize) return { deleted: total, examined: index + 1, failed, next: cursorOf(row) };
    }
    return {
      deleted: total,
      examined: page.length,
      failed,
      next: page.length < scanLimit ? null : cursorOf(page[page.length - 1]),
    };
  }

  // 후보 namespace의 만료된 연속 prefix를 삭제한다. 다른 인스턴스가 잠갔거나 그 사이
  // 사라진 namespace는 null을 돌려 호출자가 다음 후보로 넘어가게 한다.
  private async pruneNamespacePrefix(
    manager: EntityManager,
    sqlite: boolean,
    namespaceId: string,
    cutoff: string,
    batchSize: number,
  ): Promise<number | null> {
    if (!sqlite) {
      const locked = (await manager.query(
        'SELECT 1 FROM vfs_change_feed_state WHERE namespace_id = $1 FOR UPDATE SKIP LOCKED',
        [namespaceId],
      )) as unknown[];
      if (locked.length === 0) return null;
    }
    const state = await readChangeFeedState(manager, namespaceId, sqlite);
    if (!state) return null;
    const rows = (await manager.query(
      sqlite
        ? `SELECT CAST(e.sequence AS TEXT) AS sequence, e.occurred_at < ? AS expired
         FROM vfs_change_event e WHERE e.namespace_id = ? ORDER BY e.sequence ASC LIMIT ?`
        : `SELECT CAST(e.sequence AS TEXT) AS sequence, e.occurred_at < $1::timestamptz AS expired
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
  }
}
