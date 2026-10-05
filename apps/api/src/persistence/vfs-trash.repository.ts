import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { isSqliteDataSource } from '../common/db-driver.js';
import { resolveTrashRetentionNodeLimit } from '../vfs/trash-policy.js';
import { resolveNamespaceQuota } from '../vfs/namespace-quota.js';
import { snapshotPathKey } from '../vfs/snapshot-path.js';
import { VfsTrashLimitExceededError } from '../vfs/vfs.errors.js';
import { VfsTrashItemNotFoundError } from '../vfs/vfs.errors.js';
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

export interface LockedTrashItem {
  readonly trash: VfsTrashEntity;
  readonly entries: VfsTrashEntryEntity[];
  readonly expired: boolean;
}

@Injectable()
export class VfsTrashRepository {
  constructor(private readonly dataSource: DataSource) {}

  // 호출자는 namespace root 잠금을 가진 mutation transaction을 전달한다.
  async findForMutation(tx: MutationTx, trashId: string): Promise<LockedTrashItem> {
    const trash = await tx.manager
      .getRepository(VfsTrashEntity)
      .findOneBy({ id: trashId, namespaceId: tx.namespaceId });
    if (!trash) throw new VfsTrashItemNotFoundError(trashId);
    const entries = await tx.manager
      .getRepository(VfsTrashEntryEntity)
      .findBy({ trashId, namespaceId: tx.namespaceId });
    const ph = new DialectPlaceholders(isSqliteDataSource(this.dataSource.options));
    const exactRows = (await tx.manager.query(
      `SELECT CAST(node_count AS TEXT) AS "nodeCount",
      CAST(logical_bytes AS TEXT) AS "logicalBytes" FROM vfs_trash
      WHERE namespace_id = ${ph.bind(tx.namespaceId)} AND id = ${ph.bind(trashId)}`,
      ph.params,
    )) as Array<{ nodeCount: string; logicalBytes: string }>;
    if (exactRows.length !== 1) throw new Error('Trash manifest changed during mutation');
    trash.nodeCount = exactRows[0].nodeCount;
    trash.logicalBytes = exactRows[0].logicalBytes;
    const entryParams = new DialectPlaceholders(isSqliteDataSource(this.dataSource.options));
    const entryRows = (await tx.manager.query(
      `SELECT id, CAST(size AS TEXT) AS size FROM vfs_trash_entry
      WHERE namespace_id = ${entryParams.bind(tx.namespaceId)} AND trash_id = ${entryParams.bind(trashId)}`,
      entryParams.params,
    )) as Array<{ id: string; size: string | null }>;
    const exactSizes = new Map(entryRows.map((row) => [row.id, row.size]));
    if (entries.length !== entryRows.length || BigInt(entries.length) !== BigInt(trash.nodeCount))
      throw new Error('Trash manifest node count mismatch');
    for (const entry of entries) {
      const size = exactSizes.get(entry.id);
      if (size === undefined) throw new Error('Trash manifest entry changed during mutation');
      entry.size = size;
    }
    const expiryParams = new DialectPlaceholders(isSqliteDataSource(this.dataSource.options));
    const rows = (await tx.manager.query(
      `SELECT expires_at <= ${
        isSqliteDataSource(this.dataSource.options)
          ? "strftime('%Y-%m-%d %H:%M:%f', 'now')"
          : 'clock_timestamp()'
      } AS expired
      FROM vfs_trash WHERE namespace_id = ${expiryParams.bind(tx.namespaceId)} AND id = ${expiryParams.bind(trashId)}`,
      expiryParams.params,
    )) as Array<{ expired: boolean | number }>;
    return { trash, entries, expired: Boolean(rows[0]?.expired) };
  }

  async consume(tx: MutationTx, item: LockedTrashItem): Promise<void> {
    const ph = new DialectPlaceholders(isSqliteDataSource(this.dataSource.options));
    const rows = (await tx.manager.query(
      `SELECT CAST(retained_trash_node_count AS TEXT) AS nodes,
        CAST(retained_trash_byte_count AS TEXT) AS bytes FROM namespace WHERE id = ${ph.bind(tx.namespaceId)}`,
      ph.params,
    )) as Array<{ nodes: string; bytes: string }>;
    const nodes = BigInt(rows[0]?.nodes ?? '-1') - BigInt(String(item.trash.nodeCount));
    const bytes = BigInt(rows[0]?.bytes ?? '-1') - BigInt(String(item.trash.logicalBytes));
    if (nodes < 0n || bytes < 0n) throw new Error('Trash namespace counter mismatch');
    await tx.manager.update(
      NamespaceEntity,
      { id: tx.namespaceId },
      {
        retainedTrashNodeCount: nodes.toString(),
        retainedTrashByteCount: bytes.toString(),
      },
    );
    const deleted = await tx.manager
      .getRepository(VfsTrashEntity)
      .delete({ id: item.trash.id, namespaceId: tx.namespaceId });
    if (deleted.affected !== 1) throw new Error('Trash item changed during mutation');
    const consumedBytes = BigInt(String(item.trash.logicalBytes));
    tx.trashByteDelta -= consumedBytes;
    tx.logicalByteDelta -= consumedBytes;
  }

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
    const counters = (await tx.manager.query(
      `SELECT CAST(retained_trash_node_count AS TEXT) AS nodes,
        CAST(retained_trash_byte_count AS TEXT) AS bytes,
        CAST(max_retained_trash_bytes AS TEXT) AS "maxRetainedTrashBytes",
        CAST(max_total_logical_bytes AS TEXT) AS "maxTotalLogicalBytes",
        exclude_trash_from_quota AS "excludeTrashFromQuota"
       FROM namespace WHERE id = ${ph.bind(tx.namespaceId)}`,
      ph.params,
    )) as Array<{
      nodes: string;
      bytes: string;
      maxRetainedTrashBytes: string | null;
      maxTotalLogicalBytes: string | null;
      excludeTrashFromQuota: boolean | number;
    }>;
    if (counters.length !== 1) throw new Error('Trash namespace missing');
    const limit = resolveTrashRetentionNodeLimit(process.env.STORIX_MAX_RETAINED_TRASH_NODES);
    const retained = BigInt(counters[0].nodes);
    const nextCount = retained + BigInt(rows.length);
    const nextBytes = BigInt(counters[0].bytes) + bytes;
    if (nextCount > BigInt(limit)) throw new VfsTrashLimitExceededError(limit);
    if (Boolean(counters[0].excludeTrashFromQuota)) {
      const quotaLimit = resolveNamespaceQuota(
        counters[0].maxTotalLogicalBytes,
        tx.maxTotalLogicalBytes,
        tx.defaultMaxTotalLogicalBytes,
      );
      const trashByteLimit = counters[0].maxRetainedTrashBytes
        ? BigInt(counters[0].maxRetainedTrashBytes) < tx.maxTotalLogicalBytes
          ? BigInt(counters[0].maxRetainedTrashBytes)
          : tx.maxTotalLogicalBytes
        : quotaLimit;
      // 이미 초과한 상태에서도 증가분이 0이면 허용한다(design 14 "기존 초과 상태").
      if (bytes > 0n && nextBytes > trashByteLimit)
        throw new VfsTrashLimitExceededError(trashByteLimit.toString());
    }
    if (nextBytes > MAX_INT64) throw new Error('namespace trash byte counter out of int64 range');

    const raw = (await tx.manager.query('SELECT CURRENT_TIMESTAMP AS now')) as Array<{ now: Date | string }>;
    const dbTime = raw[0].now;
    const deletedAt = dbTime instanceof Date ? dbTime : new Date(dbTime.replace(' ', 'T') + 'Z');
    const expiresAt = new Date(deletedAt.getTime() + RETENTION_MS);
    const root = rows[0];
    const trash = await tx.manager.save(
      VfsTrashEntity,
      tx.manager.create(VfsTrashEntity, {
        namespaceId: tx.namespaceId,
        rootType: root.type,
        originalPath,
        rootNodeId: root.id,
        rootRevision: root.revision,
        nodeCount: String(rows.length),
        logicalBytes: bytes.toString(),
        deletedAt,
        expiresAt,
      }),
    );
    for (let offset = 0; offset < rows.length; offset += 50) {
      await tx.manager.insert(
        VfsTrashEntryEntity,
        rows.slice(offset, offset + 50).map((row) => ({
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
        })),
      );
    }
    await tx.manager.update(
      NamespaceEntity,
      { id: tx.namespaceId },
      {
        retainedTrashNodeCount: nextCount.toString(),
        retainedTrashByteCount: nextBytes.toString(),
      },
    );
    tx.trashByteDelta += bytes;
    tx.logicalByteDelta += bytes;
    return trash.id;
  }

  @classifyPersistenceOperation
  async list(namespaceId: string, after: TrashListBoundary | null, limit: number): Promise<TrashPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid trash page limit');
    const pg = !isSqliteDataSource(this.dataSource.options);
    const timestamp = pg
      ? `to_char(t.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : `strftime('%Y-%m-%dT%H:%M:%fZ', t.deleted_at)`;
    const compare = pg
      ? `(t.deleted_at < $2::timestamptz OR (t.deleted_at = $2::timestamptz AND t.id > $3::uuid))`
      : `(strftime('%Y-%m-%dT%H:%M:%fZ', t.deleted_at) < ? OR (strftime('%Y-%m-%dT%H:%M:%fZ', t.deleted_at) = ? AND t.id > ?))`;
    const sql = `SELECT t.id AS "trashId", t.original_path AS "originalPath", t.root_type AS "rootType",
      t.deleted_at AS "deletedAt", t.expires_at AS "expiresAt", t.node_count AS "nodeCount",
      CAST(t.logical_bytes AS TEXT) AS "logicalBytes", ${timestamp} AS "deletedAtKey"
      FROM vfs_trash t WHERE t.namespace_id = ${pg ? '$1' : '?'}
        AND t.expires_at > ${pg ? 'CURRENT_TIMESTAMP' : "strftime('%Y-%m-%d %H:%M:%f', 'now')"}
      ${after ? `AND ${compare}` : ''}
      ORDER BY t.deleted_at DESC, t.id ASC LIMIT ${pg ? `$${after ? 4 : 2}` : '?'}`;
    const params = after
      ? pg
        ? [namespaceId, after.deletedAtKey, after.trashId, limit + 1]
        : [namespaceId, after.deletedAtKey, after.deletedAtKey, after.trashId, limit + 1]
      : [namespaceId, limit + 1];
    const raw = (await this.dataSource.query(sql, params)) as Array<Record<string, unknown>>;
    const items: TrashListItem[] = raw.slice(0, limit).map((row) => ({
      trashId: String(row.trashId),
      originalPath: String(row.originalPath),
      rootType: row.rootType as 'FILE' | 'DIRECTORY',
      deletedAt:
        row.deletedAt instanceof Date
          ? row.deletedAt
          : new Date(String(row.deletedAt).replace(' ', 'T') + 'Z'),
      expiresAt:
        row.expiresAt instanceof Date
          ? row.expiresAt
          : new Date(String(row.expiresAt).replace(' ', 'T') + 'Z'),
      nodeCount: Number(row.nodeCount),
      logicalBytes: String(row.logicalBytes),
      deletedAtKey: String(row.deletedAtKey),
    }));
    const last = items.at(-1);
    return {
      items,
      nextBoundary:
        raw.length > limit && last ? { deletedAtKey: last.deletedAtKey, trashId: last.trashId } : null,
    };
  }
}
