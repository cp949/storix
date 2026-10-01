import { NamespaceEntity } from './entities/namespace.entity.js';
import { Injectable } from '@nestjs/common';
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
}

@Injectable()
export class VfsTrashRetentionRepository {
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
        // 후보 조회 뒤 삭제 완료로 root가 없어질 수 있다. ACTIVE root 손상은 숨기지 않는다.
        if (error instanceof VfsNodeNotFoundError) {
          const namespace = await this.dataSource.manager.findOneBy(NamespaceEntity, { id: row.namespaceId });
          if (namespace && namespace.status !== 'ACTIVE') continue;
        }
        throw error;
      }
      items++;
      nodes += BigInt(row.nodeCount);
      bytes += BigInt(row.logicalBytes);
    }
    return { items, nodes: Number(nodes), bytes: bytes.toString() };
  }
}
