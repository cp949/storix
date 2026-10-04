import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import { parseSqlTimestamp } from './vfs-node.repository.helpers.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { VfsTrashLimitExceededError } from '../vfs/vfs.errors.js';

/** 만료 삭제의 재개 위치. `(expires_at, id)` 순서에서 마지막으로 읽은 후보다. */
export interface FileExpiryCursor {
  readonly expiresAt: string;
  readonly id: string;
}

export interface ExpiredFileBatch {
  readonly files: number;
  readonly bytes: string;

  /** 이번 호출이 읽은 후보 수. GC 단계 예산을 소모하는 단위다. */
  readonly examined: number;

  /** 이어 호출할 위치. null이면 `after` 뒤에 후보가 더 없다. */
  readonly next: FileExpiryCursor | null;
}

@Injectable()
export class VfsFileExpiryRepository {
  private readonly logger = new Logger(VfsFileExpiryRepository.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly nodes: VfsNodeRepository,
  ) {}

  /**
   * `after` 뒤의 만료 후보를 `(expires_at, id)` keyset으로 한 batch 읽어 삭제한다. 만료 삭제에 실패한
   * 항목은 `next`가 전진하므로 같은 실행에서 다시 읽지 않고 다음 실행에서 다시 후보가 된다.
   */
  async expireDue(batchSize: number, after: FileExpiryCursor | null = null): Promise<ExpiredFileBatch> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500)
      throw new Error('Invalid file expiry batch size');
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const nowExpr = sqlite ? "strftime('%Y-%m-%d %H:%M:%f', 'now')" : 'clock_timestamp()';
    const [{ cutoff }] = (await this.dataSource.query(`SELECT ${nowExpr} AS cutoff`)) as Array<{
      cutoff: Date | string;
    }>;
    const cutoffDate = parseSqlTimestamp(cutoff);
    const ph = new DialectPlaceholders(sqlite);
    let sql = `SELECT n.id AS "id", n.namespace_id AS "namespaceId", n.expires_at AS "expiresAt"
        FROM vfs_node n JOIN namespace ns ON ns.id = n.namespace_id
        WHERE n.type = 'FILE' AND n.expires_at IS NOT NULL AND n.expires_at <= ${ph.bind(cutoff)}
          AND ns.status = 'ACTIVE'`;
    if (after) sql += ` AND (n.expires_at, n.id) > (${ph.bind(after.expiresAt)}, ${ph.bind(after.id)})`;
    sql += ` ORDER BY n.expires_at ASC, n.id ASC LIMIT ${ph.bind(batchSize)}`;
    const rows = (await this.dataSource.query(sql, ph.params)) as Array<{
      id: string;
      namespaceId: string;
      expiresAt: Date | string;
    }>;
    let files = 0;
    let bytes = 0n;
    for (const row of rows) {
      try {
        const expired = await this.nodes.expireNode(row.namespaceId, row.id, cutoffDate);
        if (expired) {
          files += 1;
          bytes += BigInt(expired.size);
        }
      } catch (error) {
        // 실패한 항목은 다음 GC 실행에서 다시 조회된다.
        if (error instanceof VfsTrashLimitExceededError) {
          // 휴지통 항목이 purge되거나 비워질 때까지 파일이 live로 남는다. 일반 실패와 구분해 원인을 드러낸다.
          this.logger.warn(
            `휴지통 보존 상한으로 파일 만료 삭제를 건너뜀 namespace=${row.namespaceId} node=${row.id}: ${error.message}`,
          );
        } else {
          this.logger.warn(
            `파일 만료 삭제 실패 namespace=${row.namespaceId} node=${row.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const last = rows[rows.length - 1];
    return {
      files,
      bytes: bytes.toString(),
      examined: rows.length,
      next:
        rows.length < batchSize
          ? null
          : {
              expiresAt: last.expiresAt instanceof Date ? last.expiresAt.toISOString() : last.expiresAt,
              id: last.id,
            },
    };
  }
}
