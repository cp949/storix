import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { isSqliteDataSource } from '../common/db-driver.js';
import { resolveTrashRetentionNodeLimit } from '../vfs/trash-policy.js';
import { snapshotPathKey } from '../vfs/snapshot-path.js';
import { VfsTrashLimitExceededError } from '../vfs/vfs.errors.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import { VfsTrashEntity } from './entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from './entities/vfs-trash-entry.entity.js';
import type { MutationTx, SnapshotSourceRow } from './vfs-node.repository.types.js';

const MAX_INT64 = 9223372036854775807n;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrashListBoundary {
  readonly deletedAtKey: string;
  readonly trashId: string;
}
export interface TrashListItem {
  readonly trashId: string;
  readonly originalPath: string;
  readonly rootType: 'FILE' | 'DIRECTORY';
  readonly deletedAt: Date;
  readonly expiresAt: Date;
  readonly nodeCount: number;
  readonly logicalBytes: string;
  readonly deletedAtKey: string;
}
export interface TrashPage {
  readonly items: TrashListItem[];
  readonly nextBoundary: TrashListBoundary | null;
}

@Injectable()
export class VfsTrashRepository {
  constructor(private readonly dataSource: DataSource) {}

  @classifyPersistenceOperation
  async capture(tx: MutationTx, originalPath: string, rows: readonly SnapshotSourceRow[]): Promise<string> {
    if (rows.length === 0 || rows[0].relativePath !== '.') throw new Error('Invalid trash subtree');
    let bytes = 0n;
    for (const row of rows) {
      if (row.type === 'FILE') {
        if (!row.blobId || row.size === null || row.mimeType === null)
          throw new Error('FILE trash source missing Blob metadata');
        bytes += BigInt(row.size);
      } else if (row.blobId !== null || row.size !== null || row.mimeType !== null) {
        throw new Error('DIRECTORY trash source has Blob metadata');
      }
    }
    // SQLite의 TypeORM bigint 조회는 JS number로 변환되므로 드라이버 경계 전에 문자열로 읽는다.
    const ph = new DialectPlaceholders(isSqliteDataSource(this.dataSource.options));
    const counters = await tx.manager.query(
      `SELECT CAST(retained_trash_node_count AS TEXT) AS nodes,
        CAST(retained_trash_byte_count AS TEXT) AS bytes
       FROM namespace WHERE id = ${ph.bind(tx.namespaceId)}`,
      ph.params,
    ) as Array<{ nodes: string; bytes: string }>;
    if (counters.length !== 1) throw new Error('Trash namespace missing');
    const limit = resolveTrashRetentionNodeLimit(process.env.STORIX_MAX_RETAINED_TRASH_NODES);
    const retained = BigInt(counters[0].nodes);
    const nextCount = retained + BigInt(rows.length);
    const nextBytes = BigInt(counters[0].bytes) + bytes;
    if (nextCount > BigInt(limit)) throw new VfsTrashLimitExceededError(limit);
    if (nextBytes > MAX_INT64) throw new Error('namespace trash byte counter out of int64 range');

    const raw = await tx.manager.query('SELECT CURRENT_TIMESTAMP AS now') as Array<{ now: Date | string }>;
    const dbTime = raw[0].now;
    const deletedAt = dbTime instanceof Date ? dbTime : new Date(dbTime.replace(' ', 'T') + 'Z');
    const expiresAt = new Date(deletedAt.getTime() + RETENTION_MS);
    const root = rows[0];
    const trash = await tx.manager.save(VfsTrashEntity, tx.manager.create(VfsTrashEntity, {
      namespaceId: tx.namespaceId,
      rootType: root.type,
      originalPath,
      rootNodeId: root.id,
      rootRevision: root.revision,
      nodeCount: String(rows.length),
      logicalBytes: bytes.toString(),
      deletedAt,
      expiresAt,
    }));
    for (let offset = 0; offset < rows.length; offset += 50) {
      await tx.manager.insert(VfsTrashEntryEntity, rows.slice(offset, offset + 50).map((row) => ({
        namespaceId: tx.namespaceId,
        trashId: trash.id,
        relativePath: row.relativePath,
        pathKey: snapshotPathKey(row.relativePath),
        type: row.type,
        sourceNodeId: row.id,
        sourceRevision: row.revision,
        blobId: row.blobId,
        size: row.size,
        mimeType: row.mimeType,
      })));
    }
    await tx.manager.update(NamespaceEntity, { id: tx.namespaceId }, {
      retainedTrashNodeCount: nextCount.toString(), retainedTrashByteCount: nextBytes.toString(),
    });
    tx.logicalByteDelta += bytes;
    return trash.id;
  }

  @classifyPersistenceOperation
  async list(namespaceId: string, after: TrashListBoundary | null, limit: number): Promise<TrashPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid trash page limit');
    const pg = !isSqliteDataSource(this.dataSource.options);
    const timestamp = pg
      ? `to_char(t.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : `strftime('%Y-%m-%dT%H:%M:%fZ', t.deleted_at)`;
    const compare = pg
      ? `(t.deleted_at < $2::timestamptz OR (t.deleted_at = $2::timestamptz AND t.id > $3::uuid))`
      : `(strftime('%Y-%m-%dT%H:%M:%fZ', t.deleted_at) < ? OR (strftime('%Y-%m-%dT%H:%M:%fZ', t.deleted_at) = ? AND t.id > ?))`;
    const sql = `SELECT t.id AS "trashId", t.original_path AS "originalPath", t.root_type AS "rootType",
      t.deleted_at AS "deletedAt", t.expires_at AS "expiresAt", t.node_count AS "nodeCount",
      t.logical_bytes AS "logicalBytes", ${timestamp} AS "deletedAtKey"
      FROM vfs_trash t WHERE t.namespace_id = ${pg ? '$1' : '?'}
        AND t.expires_at > ${pg ? 'CURRENT_TIMESTAMP' : "strftime('%Y-%m-%d %H:%M:%f', 'now')"}
      ${after ? `AND ${compare}` : ''}
      ORDER BY t.deleted_at DESC, t.id ASC LIMIT ${pg ? `$${after ? 4 : 2}` : '?'}`;
    const params = after
      ? pg
        ? [namespaceId, after.deletedAtKey, after.trashId, limit + 1]
        : [namespaceId, after.deletedAtKey, after.deletedAtKey, after.trashId, limit + 1]
      : [namespaceId, limit + 1];
    const raw = await this.dataSource.query(sql, params) as Array<Record<string, unknown>>;
    const items: TrashListItem[] = raw.slice(0, limit).map((row) => ({
      trashId: String(row.trashId),
      originalPath: String(row.originalPath),
      rootType: row.rootType as 'FILE' | 'DIRECTORY',
      deletedAt: row.deletedAt instanceof Date ? row.deletedAt : new Date(String(row.deletedAt).replace(' ', 'T') + 'Z'),
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt).replace(' ', 'T') + 'Z'),
      nodeCount: Number(row.nodeCount),
      logicalBytes: String(row.logicalBytes),
      deletedAtKey: String(row.deletedAtKey),
    }));
    const last = items.at(-1);
    return { items, nextBoundary: raw.length > limit && last
      ? { deletedAtKey: last.deletedAtKey, trashId: last.trashId } : null };
  }
}
