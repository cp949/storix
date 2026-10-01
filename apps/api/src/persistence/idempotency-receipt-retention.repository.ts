import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';

/** namespace 생성·관리 receipt(`idempotency_key`)의 보존 기간(일). VFS mutation receipt와 같다(ADR-0024). */
export const IDEMPOTENCY_RECEIPT_RETENTION_DAYS = 30;

/**
 * 보존 기간을 넘긴 `idempotency_key` 행을 지운다(생성 201·이름 충돌 409·quota/trash 관리 receipt 모두).
 * 기간이 지난 key의 재요청은 새 요청으로 처리된다. 규칙은 api ADR-0034.
 */
@Injectable()
export class IdempotencyReceiptRetentionRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * `created_at`이 `days`일보다 오래된 행을 오래된 것부터 최대 `batchSize`개 지우고 지운 수를 돌려준다.
   * `idx_idempotency_key_created_at` 범위 스캔이라 비용이 전체 행 수가 아니라 지우는 수에 비례한다.
   */
  async pruneExpiredBatch(days: number, batchSize: number): Promise<number> {
    if (
      !Number.isSafeInteger(days) ||
      days < 1 ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 1000
    )
      throw new Error('Invalid idempotency receipt prune arguments');
    const sqlite = isSqliteDataSource(this.dataSource.options);
    if (sqlite) {
      const rows = (await this.dataSource.query(
        `DELETE FROM idempotency_key WHERE key IN (
           SELECT key FROM idempotency_key WHERE created_at < datetime('now', '-' || ? || ' days')
           ORDER BY created_at, key LIMIT ?) RETURNING key`,
        [days, batchSize],
      )) as unknown[];
      return rows.length;
    }
    // PostgreSQL의 DELETE는 query()가 [행, 개수]를 돌려주므로 CTE로 개수를 SELECT한다.
    const counted = (await this.dataSource.query(
      `WITH deleted AS (
         DELETE FROM idempotency_key WHERE key IN (
           SELECT key FROM idempotency_key WHERE created_at < now() - ($1::int * interval '1 day')
           ORDER BY created_at, key LIMIT $2) RETURNING 1)
       SELECT count(*)::int AS n FROM deleted`,
      [days, batchSize],
    )) as Array<{ n: number }>;
    return counted[0].n;
  }
}
