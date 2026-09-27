import { classifyPersistenceOperation } from './persistence-failure.js';
import { encodeRevision } from '../vfs/revision.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import { VfsNodeNotFoundError } from '../vfs/vfs.errors.js';
import type { MutationTx, SnapshotSourceRow, CopySourceRow } from './vfs-node.repository.types.js';
import { joinSegments } from './vfs-node.repository.helpers.js';
import { VfsNodeRepositoryReads } from './vfs-node.repository.reads.js';

export class VfsNodeRepositorySnapshots extends VfsNodeRepositoryReads {
  // ORDER BY 없는 LIMIT으로 PostgreSQL recursive CTE의 평가도 maxNodes + 1에서
  // 멈춘다. SQLite는 recursive term 내부 LIMIT으로 큐의 확장까지 제한한다.
  @classifyPersistenceOperation
  async captureSnapshotRows(
    tx: MutationTx,
    segments: string[],
    maxNodes: number,
  ): Promise<SnapshotSourceRow[]> {
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new Error('Invalid snapshot node limit');
    const source = await this.resolvePathInManager(tx.manager, tx.namespaceId, tx.rootId, segments);
    if (!source) throw new VfsNodeNotFoundError(joinSegments(segments));
    const ph = new DialectPlaceholders(this.isSqlite);
    const namespace = ph.bind(tx.namespaceId);
    const sourceId = ph.bind(source.id);
    const childNamespace = ph.bind(tx.namespaceId);
    const bound = ph.bind(maxNodes + 1);
    const rows: (CopySourceRow & { version: number; relative_path: string })[] = await tx.manager.query(
      `WITH RECURSIVE tree AS (
        SELECT id, parent_id, type, name, blob_id, size, mime_type, version, '.' AS relative_path
        FROM vfs_node WHERE namespace_id = ${namespace} AND id = ${sourceId}
        UNION ALL
        SELECT n.id, n.parent_id, n.type, n.name, n.blob_id, n.size, n.mime_type, n.version,
          CASE WHEN t.relative_path = '.' THEN n.name ELSE t.relative_path || '/' || n.name END
        FROM vfs_node n JOIN tree t ON n.parent_id = t.id
        WHERE n.namespace_id = ${childNamespace}
        ${this.isSqlite ? `LIMIT ${bound}` : ''}
      ) SELECT * FROM tree ${this.isSqlite ? '' : `LIMIT ${bound}`}`,
      ph.params,
    );
    // SQL 밖에서 bounded 결과만 정렬하여 recursive CTE의 조기 LIMIT을 유지한다.
    // capture의 첫 행은 source root이며 나머지는 UTF-8 byte 순서다.
    rows.sort((left, right) => {
      if (left.relative_path === right.relative_path) return 0;
      if (left.relative_path === '.') return -1;
      if (right.relative_path === '.') return 1;
      return Buffer.compare(
        Buffer.from(left.relative_path, 'utf8'),
        Buffer.from(right.relative_path, 'utf8'),
      );
    });
    return rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      type: row.type,
      revision: encodeRevision(row),
      relativePath: row.relative_path,
      blobId: row.blob_id,
      size: row.size === null ? null : String(row.size),
      mimeType: row.mime_type,
    }));
  }
}
