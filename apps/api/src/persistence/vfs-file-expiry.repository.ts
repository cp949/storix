import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import { parseSqlTimestamp } from './vfs-node.repository.helpers.js';
import { VfsNodeRepository } from './vfs-node.repository.js';

export interface ExpiredFileBatch {
  readonly files: number;
  readonly bytes: string;
}

// 실행 시작 시 DB 시각을 고정하고 (expires_at, id) keyset으로 후보를 순회한다.
@Injectable()
export class VfsFileExpiryRepository {
  private readonly logger = new Logger(VfsFileExpiryRepository.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly nodes: VfsNodeRepository,
  ) {}

  async expireDue(batchSize: number): Promise<ExpiredFileBatch> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500)
      throw new Error('Invalid file expiry batch size');
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const nowExpr = sqlite ? "strftime('%Y-%m-%d %H:%M:%f', 'now')" : 'clock_timestamp()';
    const [{ cutoff }] = (await this.dataSource.query(`SELECT ${nowExpr} AS cutoff`)) as Array<{
      cutoff: Date | string;
    }>;
    const cutoffDate = parseSqlTimestamp(cutoff);
    let after: { expiresAt: Date | string; id: string } | null = null;
    let files = 0;
    let bytes = 0n;
    for (;;) {
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
      for (const row of rows) {
        try {
          const expired = await this.nodes.expireNode(row.namespaceId, row.id, cutoffDate);
          if (expired) {
            files += 1;
            bytes += BigInt(expired.size);
          }
        } catch (error) {
          // 실패한 항목은 다음 GC 실행에서 다시 조회된다.
          this.logger.warn(
            `파일 만료 삭제 실패 namespace=${row.namespaceId} node=${row.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (rows.length < batchSize) break;
      after = rows[rows.length - 1];
    }
    return { files, bytes: bytes.toString() };
  }
}
