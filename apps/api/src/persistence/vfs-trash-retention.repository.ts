import { NamespaceEntity } from './entities/namespace.entity.js';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import {
  VfsTrashItemNotFoundError,
  VfsNamespaceNotFoundError,
  VfsNodeNotFoundError,
} from '../vfs/vfs.errors.js';
import { VfsNodeRepository } from './vfs-node.repository.js';

export interface PrunedTrashBatch {
  readonly items: number;
  readonly nodes: number;
  readonly bytes: string;

  /** 예상 밖 오류로 정리하지 못하고 남긴 항목 수다. 다음 실행에서 다시 시도한다. */
  readonly failed: number;
}

@Injectable()
export class VfsTrashRetentionRepository {
  private readonly logger = new Logger(VfsTrashRetentionRepository.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly nodes: VfsNodeRepository,
  ) {}

  async pruneExpiredBatch(limit: number): Promise<PrunedTrashBatch> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid trash prune limit');
    const sqlite = isSqliteDataSource(this.dataSource.options);
    const rows = (await this.dataSource.query(
      `SELECT vfs_trash.id, namespace_id AS "namespaceId", CAST(node_count AS TEXT) AS "nodeCount",
        CAST(logical_bytes AS TEXT) AS "logicalBytes" FROM vfs_trash
       JOIN namespace ns ON ns.id = vfs_trash.namespace_id AND ns.status = 'ACTIVE'
       WHERE expires_at <= ${sqlite ? "strftime('%Y-%m-%d %H:%M:%f', 'now')" : 'clock_timestamp()'}
       ORDER BY expires_at ASC, namespace_id ASC, vfs_trash.id ASC LIMIT ${sqlite ? '?' : '$1'}`,
      [limit],
    )) as Array<{ id: string; namespaceId: string; nodeCount: string; logicalBytes: string }>;
    const selectedNodes = rows.reduce((total, row) => total + BigInt(row.nodeCount), 0n);
    if (selectedNodes > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Trash prune node count exceeds safe integer');
    let items = 0;
    let failed = 0;
    let nodes = 0n;
    let bytes = 0n;
    for (const row of rows) {
      try {
        // purgeTrashItem takes the namespace root lock and commits the manifest,
        // counter, and Blob reference transition as one mutation.
        await this.nodes.purgeTrashItem(row.namespaceId, row.id);
      } catch (error) {
        // Another purge or restore may consume a selected item before its lock is acquired.
        if (error instanceof VfsTrashItemNotFoundError || error instanceof VfsNamespaceNotFoundError)
          continue;
        // 후보 조회 뒤 삭제 완료로 root가 없어질 수 있다.
        if (error instanceof VfsNodeNotFoundError) {
          const namespace = await this.dataSource.manager.findOneBy(NamespaceEntity, { id: row.namespaceId });
          if (namespace && namespace.status !== 'ACTIVE') continue;
        }
        // ACTIVE root 손상·manifest 불일치 같은 예상 밖 오류는 error 로그와 실패 수로 드러낸다.
        // 이 항목은 expires_at이 가장 이르므로 다시 던지면 모든 namespace의 정리가 매번 여기서 멈춘다.
        failed++;
        this.logger.error(
          `휴지통 보존 정리 실패 namespace=${row.namespaceId} trash=${row.id}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        continue;
      }
      items++;
      nodes += BigInt(row.nodeCount);
      bytes += BigInt(row.logicalBytes);
    }
    return { items, nodes: Number(nodes), bytes: bytes.toString(), failed };
  }
}
