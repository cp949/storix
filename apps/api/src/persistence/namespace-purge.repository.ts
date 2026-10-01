import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { DialectPlaceholders } from './dialect-placeholders.js';

/** 삭제 완료 namespace의 기본 보존 기간(일). `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`로 바꾼다. */
export const DEFAULT_NAMESPACE_DELETED_RETENTION_DAYS = 30;

/** 보존 기간 env를 읽는다. 없으면 기본값이고 양의 안전한 정수가 아니면 시작을 거부한다. */
export function resolveNamespaceDeletedRetentionDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_NAMESPACE_DELETED_RETENTION_DAYS;
  if (!/^[1-9][0-9]*$/.test(value))
    throw new Error('STORIX_NAMESPACE_DELETED_RETENTION_DAYS는 양의 정수여야 합니다');
  const days = Number(value);
  if (!Number.isSafeInteger(days))
    throw new Error('STORIX_NAMESPACE_DELETED_RETENTION_DAYS는 안전한 정수여야 합니다');
  return days;
}

/** 보존 만료 후보 순회의 재개 위치. `(completed_at, namespace_id)` 순서에서 마지막으로 읽은 후보다. */
export interface NamespacePurgeCursor {
  readonly completedAt: string;
  readonly namespaceId: string;
}

export interface NamespacePurgeResult {
  /** 물리 삭제한 namespace 수 */
  readonly purged: number;

  /** 남은 참조 행이 있어 건너뛴 namespace 수 */
  readonly skipped: number;

  /** 이번 호출이 읽은 후보 수. GC 단계 예산을 소모하는 단위다. */
  readonly examined: number;

  /** 이어 호출할 위치. null이면 `after` 뒤에 후보가 더 없다. */
  readonly next: NamespacePurgeCursor | null;
}

interface CandidateRow {
  readonly namespace_id: string;
  readonly completed_at: string;
}

/**
 * 삭제가 완료(`DELETED`)되고 보존 기간이 지난 namespace의 행을 물리 삭제한다. 규칙은 api ADR-0035.
 * 삭제는 되돌릴 수 없다. 완료되지 않은 operation(DELETING·보류·정산 미확정)은 후보가 아니다.
 */
@Injectable()
export class NamespacePurgeRepository {
  private readonly logger = new Logger(NamespacePurgeRepository.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * `after` 뒤의 만료 후보를 최대 `limit`개 읽어 namespace마다 한 트랜잭션으로 지운다. 지울 수 없는 후보
   * (남은 참조 행으로 FK 위반)는 건너뛰므로 같은 실행에서 다시 읽지 않는다. `idx_namespace_deletion_completed`
   * 범위 스캔이라 비용이 전체 namespace 수가 아니라 읽은 후보 수에 비례한다.
   */
  async purgeNext(
    days: number,
    after: NamespacePurgeCursor | null,
    limit: number,
  ): Promise<NamespacePurgeResult> {
    if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid namespace purge arguments');
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const ph = new DialectPlaceholders(sqlite);
    const cutoff = sqlite
      ? `datetime('now', '-' || ${ph.bind(days)} || ' days')`
      : `now() - (${ph.bind(days)}::int * interval '1 day')`;
    const afterClause = after
      ? `AND (d.completed_at, d.namespace_id) > (${ph.bind(after.completedAt)}${sqlite ? '' : '::timestamptz'}, ${ph.bind(after.namespaceId)}${sqlite ? '' : '::uuid'})`
      : '';
    const rows = (await this.dataSource.query(
      `SELECT d.namespace_id AS namespace_id, ${sqlite ? 'd.completed_at' : 'd.completed_at::text'} AS completed_at
       FROM namespace_deletion d JOIN namespace n ON n.id = d.namespace_id
       WHERE d.phase = 'COMPLETED' AND n.status = 'DELETED' AND d.completed_at < ${cutoff} ${afterClause}
       ORDER BY d.completed_at, d.namespace_id LIMIT ${ph.bind(limit)}`,
      ph.params,
    )) as CandidateRow[];
    let purged = 0;
    let skipped = 0;
    const ids = rows.map((row) => row.namespace_id);
    if (ids.length > 0) {
      // page 전체를 한 트랜잭션으로 지운다. 하나라도 지울 수 없으면 롤백하고 namespace마다 다시 시도한다.
      try {
        await this.dataSource.transaction((manager) => this.purgeMany(manager, sqlite, ids));
        purged = ids.length;
      } catch {
        for (const id of ids) {
          try {
            await this.dataSource.transaction((manager) => this.purgeMany(manager, sqlite, [id]));
            purged++;
          } catch (error) {
            skipped++;
            this.logger.warn(
              `삭제 완료 namespace의 물리 삭제를 건너뜀 namespace=${id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    const last = rows[rows.length - 1];
    return {
      purged,
      skipped,
      examined: rows.length,
      next: rows.length < limit ? null : { completedAt: last.completed_at, namespaceId: last.namespace_id },
    };
  }

  // FK 순서: 삭제 receipt → upload 사용량(0 값) → operation → namespace. 남은 참조 행이 있으면 FK 위반으로
  // 롤백한다. 조건(status·phase)은 후보 조회 뒤 상태가 바뀐 경우를 막는다.
  private async purgeMany(manager: EntityManager, sqlite: boolean, ids: readonly string[]): Promise<void> {
    const run = async (sql: string): Promise<unknown[]> => {
      const ph = new DialectPlaceholders(sqlite);
      // PostgreSQL은 배열 파라미터 하나, SQLite는 id마다 변수 하나로 바인딩한다(page 최대 500개).
      const list = sqlite ? ids.map((id) => ph.bind(id)).join(', ') : `${ph.bind([...ids])}::uuid[]`;
      return (await manager.query(
        sql.replace('{IDS}', sqlite ? `IN (${list})` : `= ANY(${list})`),
        ph.params,
      )) as unknown[];
    };
    const eligible = await run(
      `SELECT 1 AS v FROM namespace_deletion d JOIN namespace n ON n.id = d.namespace_id
       WHERE d.namespace_id {IDS} AND d.phase = 'COMPLETED' AND n.status = 'DELETED'`,
    );
    if (eligible.length !== ids.length) throw new Error('삭제 완료 상태가 아닌 namespace가 있다');
    await run('DELETE FROM namespace_deletion_receipt WHERE namespace_id {IDS}');
    await run('DELETE FROM vfs_upload_usage WHERE namespace_id {IDS}');
    await run('DELETE FROM namespace_deletion WHERE namespace_id {IDS}');
    await run('DELETE FROM namespace WHERE id {IDS}');
  }
}
