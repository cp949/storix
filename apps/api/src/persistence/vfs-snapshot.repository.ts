import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { isSqliteDataSource } from '../common/db-driver.js';
import { parsePositiveInt } from '../common/env-parsing.js';
import {
  VfsInvalidOperationError,
  VfsNamespaceNotFoundError,
  VfsSnapshotLimitExceededError,
} from '../vfs/vfs.errors.js';
import { snapshotPathKey } from '../vfs/snapshot-path.js';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsSnapshotEntity, type VfsSnapshotKind } from './entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from './entities/vfs-snapshot-entry.entity.js';
import type { MutationTx, SnapshotSourceRow } from './vfs-node.repository.js';
import { parseSqlTimestamp } from './vfs-node.repository.helpers.js';

export type SnapshotMetadata = Readonly<VfsSnapshotEntity> & { readonly sha256: string | null };
export type LockedSnapshot = Readonly<VfsSnapshotEntity>;
export type SnapshotEntry = Readonly<VfsSnapshotEntryEntity>;
export interface SnapshotCaptureInput {
  readonly kind: VfsSnapshotKind;
  readonly sourcePath: string;
  readonly rows: readonly SnapshotSourceRow[];
}
export interface SnapshotEntryPage {
  readonly entries: SnapshotEntry[];
  readonly nextPathKey: string | null;
}
export interface FileSnapshotListBoundary {
  readonly createdAtKey: string;
  readonly snapshotId: string;
}
export interface FileSnapshotListRow {
  readonly snapshotId: string;
  readonly createdAt: Date;
  readonly createdAtKey: string;
  readonly sourceRevision: string;
  readonly logicalBytes: string;
  readonly sha256: string;
}
export interface FileSnapshotListPage {
  readonly items: FileSnapshotListRow[];
  readonly nextBoundary: FileSnapshotListBoundary | null;
}
export interface SnapshotLimits {
  readonly maxNodes: number;
  readonly maxBytes: bigint;
  readonly maxRetainedNodes: number;
  readonly maxRetainedBytes: bigint;
}

function byteLimit(namespace: string | null, env: string | undefined, fallback: bigint): bigint {
  if (env !== undefined && env !== '' && !/^[1-9][0-9]*$/.test(env))
    throw new Error('Invalid snapshot byte limit');
  const global = env === undefined || env === '' ? fallback : BigInt(env);
  return namespace === null || BigInt(namespace) > global ? global : BigInt(namespace);
}

export function resolveSnapshotLimits(namespace: NamespaceEntity): SnapshotLimits {
  const maxNodes = parsePositiveInt(process.env.STORIX_MAX_SYNC_SNAPSHOT_NODES, 1000);
  const maxRetainedNodes = parsePositiveInt(process.env.STORIX_MAX_RETAINED_SNAPSHOT_NODES, 100000);
  return {
    maxNodes: Math.min(namespace.maxSyncSnapshotNodes ?? maxNodes, maxNodes),
    maxBytes: byteLimit(namespace.maxSnapshotBytes, process.env.STORIX_MAX_SNAPSHOT_BYTES, 5368709120n),
    maxRetainedNodes: Math.min(namespace.maxRetainedSnapshotNodes ?? maxRetainedNodes, maxRetainedNodes),
    maxRetainedBytes: byteLimit(
      namespace.maxRetainedSnapshotBytes,
      process.env.STORIX_MAX_RETAINED_SNAPSHOT_BYTES,
      53687091200n,
    ),
  };
}

function metadata(entity: VfsSnapshotEntity, sha256: string | null): SnapshotMetadata {
  return { ...entity, logicalBytes: String(entity.logicalBytes), sha256 };
}
function entry(entity: VfsSnapshotEntryEntity): SnapshotEntry {
  return { ...entity, size: entity.size === null ? null : String(entity.size) };
}

@Injectable()
export class VfsSnapshotRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly blobs: BlobRepository,
  ) {}

  private async fileSha256(manager: EntityManager, snapshot: VfsSnapshotEntity): Promise<string | null> {
    if (snapshot.kind === 'TREE') return null;
    const root = await manager.findOneBy(VfsSnapshotEntryEntity, {
      namespaceId: snapshot.namespaceId,
      snapshotId: snapshot.id,
      relativePath: '.',
      type: 'FILE',
      sourceNodeId: snapshot.rootNodeId,
    });
    // 같은 읽기 트랜잭션에서 snapshot 행을 읽은 뒤이므로 root entry·Blob 부재는 요청 오류가 아닌 저장 상태 손상이다.
    if (!root?.blobId) throw new Error('FILE snapshot의 root entry가 없음 — 데이터 일관성 위반');
    const blob = await manager.findOneBy(BlobEntity, {
      id: root.blobId,
      namespaceId: snapshot.namespaceId,
    });
    if (!blob) throw new Error('FILE snapshot root entry가 참조하는 Blob이 없음 — 데이터 일관성 위반');
    return blob.sha256;
  }

  @classifyPersistenceOperation
  async capture(tx: MutationTx, input: SnapshotCaptureInput): Promise<SnapshotMetadata> {
    const namespace = await tx.manager.findOneBy(NamespaceEntity, { id: tx.namespaceId });
    if (!namespace) throw new VfsNamespaceNotFoundError(tx.namespaceId);
    const limits = resolveSnapshotLimits(namespace);
    const root = input.rows[0];
    if (
      !root ||
      root.relativePath !== '.' ||
      (input.kind === 'FILE' && (root.type !== 'FILE' || input.rows.length !== 1)) ||
      (input.kind === 'TREE' && root.type !== 'DIRECTORY')
    ) {
      throw new VfsInvalidOperationError(input.sourcePath);
    }
    let bytes = 0n;
    const refs = new Map<string, number>();
    const paths = new Set<string>();
    for (const row of input.rows) {
      if (paths.has(row.relativePath)) throw new VfsInvalidOperationError(input.sourcePath);
      paths.add(row.relativePath);
      if (row.type === 'FILE') {
        if (!row.blobId || row.size === null || !/^\d+$/.test(row.size) || !row.mimeType)
          throw new VfsInvalidOperationError(input.sourcePath);
        bytes += BigInt(row.size);
        refs.set(row.blobId, (refs.get(row.blobId) ?? 0) + 1);
      } else if (row.blobId !== null || row.size !== null || row.mimeType !== null) {
        throw new VfsInvalidOperationError(input.sourcePath);
      }
    }
    const count = input.rows.length;
    if (
      count > limits.maxNodes ||
      bytes > limits.maxBytes ||
      count > limits.maxRetainedNodes ||
      bytes > limits.maxRetainedBytes
    ) {
      throw new VfsSnapshotLimitExceededError();
    }
    // namespace root lock에 더해 조건부 UPDATE가 누적 보존 예산을 보호한다.
    const charged = await tx.manager
      .createQueryBuilder()
      .update(NamespaceEntity)
      .set({
        retainedSnapshotNodeCount: () => 'retained_snapshot_node_count + :count',
        retainedSnapshotByteCount: () => 'retained_snapshot_byte_count + :bytes',
      })
      .where(
        'id = :namespaceId AND retained_snapshot_node_count <= :remainingNodes AND retained_snapshot_byte_count <= :remainingBytes',
        {
          namespaceId: tx.namespaceId,
          count,
          bytes: bytes.toString(),
          remainingNodes: limits.maxRetainedNodes - count,
          remainingBytes: (limits.maxRetainedBytes - bytes).toString(),
        },
      )
      .execute();
    if (charged.affected !== 1) throw new VfsSnapshotLimitExceededError();
    tx.logicalByteDelta += bytes;
    tx.snapshotByteDelta += bytes;
    for (const [blobId, occurrences] of refs) {
      if (!(await this.blobs.incrementLiveReferenceCount(tx.manager, tx.namespaceId, blobId, occurrences))) {
        throw new VfsInvalidOperationError(input.sourcePath);
      }
    }
    const snapshot = await tx.manager.save(
      VfsSnapshotEntity,
      tx.manager.create(VfsSnapshotEntity, {
        namespaceId: tx.namespaceId,
        kind: input.kind,
        sourcePath: input.sourcePath,
        rootNodeId: root.id,
        sourceRevision: root.revision,
        rootType: root.type,
        nodeCount: count,
        logicalBytes: bytes.toString(),
      }),
    );
    // 청크별 insert로 SQLite bind 변수 상한을 피한다.
    for (let offset = 0; offset < count; offset += 50) {
      await tx.manager.insert(
        VfsSnapshotEntryEntity,
        input.rows.slice(offset, offset + 50).map((row) => ({
          namespaceId: tx.namespaceId,
          snapshotId: snapshot.id,
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
    return metadata(snapshot, await this.fileSha256(tx.manager, snapshot));
  }

  @classifyPersistenceOperation
  async findForUpdate(
    tx: MutationTx,
    namespaceId: string,
    snapshotId: string,
  ): Promise<LockedSnapshot | null> {
    if (namespaceId !== tx.namespaceId) return null;
    const query = tx.manager
      .createQueryBuilder(VfsSnapshotEntity, 's')
      .where('s.namespace_id = :namespaceId AND s.id = :snapshotId', { namespaceId, snapshotId });
    if (!isSqliteDataSource(this.dataSource.options)) query.setLock('pessimistic_write');
    const result = await query.getOne();
    return result ? { ...result, logicalBytes: String(result.logicalBytes) } : null;
  }

  @classifyPersistenceOperation
  async getEntry(tx: MutationTx, snapshotId: string, relativePath: string): Promise<SnapshotEntry | null> {
    const result = await tx.manager.findOneBy(VfsSnapshotEntryEntity, {
      namespaceId: tx.namespaceId,
      snapshotId,
      relativePath,
    });
    return result ? entry(result) : null;
  }

  @classifyPersistenceOperation
  async getFileEntry(tx: MutationTx, snapshotId: string): Promise<SnapshotEntry | null> {
    const snapshot = await tx.manager.findOneBy(VfsSnapshotEntity, {
      id: snapshotId,
      namespaceId: tx.namespaceId,
      kind: 'FILE',
    });
    if (!snapshot) return null;
    const result = await tx.manager.findOneBy(VfsSnapshotEntryEntity, {
      namespaceId: tx.namespaceId,
      snapshotId,
      relativePath: '.',
      type: 'FILE',
    });
    return result ? entry(result) : null;
  }

  @classifyPersistenceOperation
  async get(namespaceId: string, snapshotId: string): Promise<SnapshotMetadata | null> {
    const work = async (manager: EntityManager): Promise<SnapshotMetadata | null> => {
      const result = await manager.findOneBy(VfsSnapshotEntity, { id: snapshotId, namespaceId });
      return result ? metadata(result, await this.fileSha256(manager, result)) : null;
    };
    return isSqliteDataSource(this.dataSource.options)
      ? this.dataSource.transaction(work)
      : this.dataSource.transaction('REPEATABLE READ', work);
  }

  @classifyPersistenceOperation
  async listFileSnapshots(
    namespaceId: string,
    rootNodeId: string,
    after: FileSnapshotListBoundary | null,
    limit: number,
  ): Promise<FileSnapshotListPage> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid snapshot page limit');
    const pg = !isSqliteDataSource(this.dataSource.options);
    const timestamp = pg
      ? `to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : `strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at)`;
    const compare = pg
      ? `(s.created_at < $3::timestamptz OR (s.created_at = $3::timestamptz AND s.id > $4::uuid))`
      : `(strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at) < ? OR (strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at) = ? AND s.id > ?))`;
    const sql = `SELECT s.id AS "snapshotId", s.created_at AS "createdAt", ${timestamp} AS "createdAtKey",
      s.source_revision AS "sourceRevision", s.logical_bytes AS "logicalBytes", b.sha256 AS "sha256"
      FROM vfs_snapshot s
      JOIN vfs_snapshot_entry e ON e.namespace_id = s.namespace_id AND e.snapshot_id = s.id
        AND e.relative_path = '.' AND e.type = 'FILE' AND e.source_node_id = s.root_node_id
      JOIN blob b ON b.namespace_id = e.namespace_id AND b.id = e.blob_id
      WHERE s.namespace_id = ${pg ? '$1' : '?'} AND s.root_node_id = ${pg ? '$2' : '?'} AND s.kind = 'FILE'
        ${after ? `AND ${compare}` : ''}
      ORDER BY s.created_at DESC, s.id ASC LIMIT ${pg ? `$${after ? 5 : 3}` : '?'} `;
    const params = after
      ? pg
        ? [namespaceId, rootNodeId, after.createdAtKey, after.snapshotId, limit + 1]
        : [namespaceId, rootNodeId, after.createdAtKey, after.createdAtKey, after.snapshotId, limit + 1]
      : [namespaceId, rootNodeId, limit + 1];
    const raw = (await this.dataSource.query(sql, params)) as Array<Record<string, unknown>>;
    const items = raw.slice(0, limit).map((row) => ({
      snapshotId: String(row.snapshotId),
      createdAt: parseSqlTimestamp(row.createdAt as Date | string),
      createdAtKey: String(row.createdAtKey),
      sourceRevision: String(row.sourceRevision),
      logicalBytes: String(row.logicalBytes),
      sha256: String(row.sha256).trim(),
    }));
    const last = items.at(-1);
    return {
      items,
      nextBoundary:
        raw.length > limit && last ? { createdAtKey: last.createdAtKey, snapshotId: last.snapshotId } : null,
    };
  }

  @classifyPersistenceOperation
  async listEntries(
    namespaceId: string,
    snapshotId: string,
    afterPathKey: string | null,
    limit: number,
  ): Promise<SnapshotEntryPage> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid snapshot page limit');
    const collated = `e.path_key COLLATE ${isSqliteDataSource(this.dataSource.options) ? 'BINARY' : '"C"'}`;
    const query = this.dataSource
      .createQueryBuilder(VfsSnapshotEntryEntity, 'e')
      .where('e.namespace_id = :namespaceId AND e.snapshot_id = :snapshotId', { namespaceId, snapshotId });
    if (afterPathKey !== null) query.andWhere(`${collated} > :afterPathKey`, { afterPathKey });
    const rows = await query
      .orderBy(collated, 'ASC')
      .limit(limit + 1)
      .getMany();
    const entries = rows.slice(0, limit).map(entry);
    return { entries, nextPathKey: rows.length > limit ? entries[entries.length - 1].pathKey : null };
  }

  @classifyPersistenceOperation
  async remove(tx: MutationTx, snapshot: LockedSnapshot): Promise<void> {
    if (snapshot.namespaceId !== tx.namespaceId) throw new VfsInvalidOperationError(snapshot.sourcePath);
    // 같은 locked value로 재호출해도 예산과 참조를 두 번 해제하지 않는다.
    const current = await tx.manager.findOneBy(VfsSnapshotEntity, {
      id: snapshot.id,
      namespaceId: tx.namespaceId,
    });
    if (!current) return;
    const entries = await tx.manager.findBy(VfsSnapshotEntryEntity, {
      snapshotId: current.id,
      namespaceId: tx.namespaceId,
    });
    const refs = new Map<string, number>();
    for (const item of entries) if (item.blobId) refs.set(item.blobId, (refs.get(item.blobId) ?? 0) + 1);
    for (const [blobId, count] of refs) await this.blobs.decrementReferenceCount(tx.manager, blobId, count);
    await tx.manager.delete(VfsSnapshotEntity, { id: current.id, namespaceId: tx.namespaceId });
    await tx.manager
      .createQueryBuilder()
      .update(NamespaceEntity)
      .set({
        retainedSnapshotNodeCount: () => 'retained_snapshot_node_count - :count',
        retainedSnapshotByteCount: () => 'retained_snapshot_byte_count - :bytes',
      })
      .where('id = :namespaceId', {
        namespaceId: tx.namespaceId,
        count: current.nodeCount,
        bytes: String(current.logicalBytes),
      })
      .execute();
    const removedBytes = BigInt(String(current.logicalBytes));
    tx.snapshotByteDelta -= removedBytes;
    tx.logicalByteDelta -= removedBytes;
  }
}
