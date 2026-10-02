/**
 * root 잠금과 단계 재검사로 namespace 정리 배치의 중복 정산을 막는다.
 * 규칙은 docs/design/13-namespace-deletion.md "영속 상태와 잠금", "GC 단계". 결정은 api ADR-0032.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { VfsNodeNotFoundError } from '../vfs/vfs.errors.js';
import { BlobRepository } from './blob.repository.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import {
  NamespaceDeletionEntity,
  type NamespaceDeletionPhase,
  type NamespaceDeletionBlockedReason,
} from './entities/namespace-deletion.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { VfsNodeRepository, type MutationTx } from './vfs-node.repository.js';
import { VfsUploadSessionRepository } from './vfs-upload-session.repository.js';

/** 데이터와 참조 수·counter가 어긋나 자동 정리를 중단해야 한다. */
export class DataInconsistencyError extends Error {}

interface ContentRow {
  id: string;
  type: string;
  blobId: string | null;
  size: string | null;
}

/** namespace UUID에 한정해 메타데이터를 지우고 완료 조건을 재검사한다. */
@Injectable()
export class NamespaceDeletionCleanupRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly nodes: VfsNodeRepository,
    private readonly blobs: BlobRepository,
    private readonly uploads: VfsUploadSessionRepository,
  ) {}

  /** 미완료 operation을 UUID 순서로 읽는다. after는 실패한 앞 namespace가 뒤 작업을 굶기지 않게 한다. */
  async listOpenOperations(limit: number, after?: string): Promise<NamespaceDeletionEntity[]> {
    const query = this.dataSource
      .getRepository(NamespaceDeletionEntity)
      .createQueryBuilder('op')
      .where('op.phase != :completed', { completed: 'COMPLETED' })
      .orderBy('op.namespace_id')
      .take(limit);
    if (after) query.andWhere('op.namespace_id > :after', { after });
    return query.getMany();
  }

  private placeholders(): DialectPlaceholders {
    return new DialectPlaceholders(isSqliteDataSource(this.dataSource.options));
  }

  private async locked<T>(
    namespaceId: string,
    phase: NamespaceDeletionPhase,
    fallback: T,
    work: (tx: MutationTx) => Promise<T>,
  ): Promise<T> {
    const root = await this.dataSource.manager.findOneBy(VfsNodeEntity, { namespaceId, parentId: IsNull() });
    if (!root) {
      const op = await this.dataSource.manager.findOneBy(NamespaceDeletionEntity, { namespaceId });
      if (op?.phase === 'COMPLETED') return fallback;
      throw new DataInconsistencyError('삭제 대상 root가 없다');
    }
    try {
      return (
        await this.nodes.withMutation(
          namespaceId,
          root.id,
          async (tx) => {
            const op = await tx.manager.findOneBy(NamespaceDeletionEntity, { namespaceId });
            if (op?.phase !== phase) return fallback;
            const ns = await tx.manager.findOneBy(NamespaceEntity, { id: namespaceId });
            if (ns?.status !== 'DELETING') throw new DataInconsistencyError('삭제 대상 상태가 어긋난다');
            return work(tx);
          },
          undefined,
          { allowInactive: true },
        )
      ).value;
    } catch (error) {
      if (
        error instanceof VfsNodeNotFoundError &&
        (await this.dataSource.manager.findOneBy(NamespaceDeletionEntity, { namespaceId }))?.phase ===
          'COMPLETED'
      )
        return fallback;
      throw error;
    }
  }

  /** 현재 단계가 일치할 때만 다음 단계로 전환한다. */
  async setPhase(
    namespaceId: string,
    from: NamespaceDeletionPhase,
    to: NamespaceDeletionPhase,
  ): Promise<boolean> {
    return this.locked(namespaceId, from, false, async ({ manager }) => {
      await manager.update(
        NamespaceDeletionEntity,
        { namespaceId, phase: from },
        { phase: to, blockedReason: null, updatedAt: new Date() },
      );
      return true;
    });
  }

  /** 완료된 operation의 결과를 뒤늦은 GC가 덮어쓰지 않는다. */
  async setBlocked(namespaceId: string, reason: NamespaceDeletionBlockedReason | null): Promise<void> {
    await this.dataSource
      .getRepository(NamespaceDeletionEntity)
      .createQueryBuilder()
      .update()
      .set({ blockedReason: reason, updatedAt: new Date() })
      .where('namespace_id = :namespaceId AND phase != :completed', { namespaceId, completed: 'COMPLETED' })
      .execute();
  }

  /** change-feed event와 checkpoint를 제거한다. 내부 삭제는 event를 기록하지 않는다. */
  async removeChangeFeed(namespaceId: string): Promise<void> {
    await this.locked(namespaceId, 'METADATA', undefined, async ({ manager }) => {
      for (const table of ['vfs_change_event', 'vfs_change_feed_state']) {
        const ph = this.placeholders();
        await manager.query(`DELETE FROM ${table} WHERE namespace_id = ${ph.bind(namespaceId)}`, ph.params);
      }
    });
  }

  private async debit(
    manager: EntityManager,
    namespaceId: string,
    amounts: Record<string, bigint>,
  ): Promise<void> {
    for (const [column, amount] of Object.entries(amounts)) {
      const ph = this.placeholders();
      const rows = (await manager.query(
        `SELECT CAST(${column} AS TEXT) AS value FROM namespace WHERE id = ${ph.bind(namespaceId)}`,
        ph.params,
      )) as { value: string }[];
      if (!rows[0] || BigInt(rows[0].value) < amount)
        throw new DataInconsistencyError(`${column} counter 불일치`);
      const update = this.placeholders();
      await manager.query(
        `UPDATE namespace SET ${column} = ${column} - ${update.bind(amount.toString())} WHERE id = ${update.bind(namespaceId)}`,
        update.params,
      );
    }
  }

  private async releaseReferences(
    manager: EntityManager,
    namespaceId: string,
    rows: ContentRow[],
  ): Promise<void> {
    const counts = new Map<string, number>();
    for (const row of rows)
      if (row.type === 'FILE') {
        if (!row.blobId || row.size === null) throw new DataInconsistencyError('FILE metadata 누락');
        counts.set(row.blobId, (counts.get(row.blobId) ?? 0) + 1);
      }
    for (const [id, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      const ph = this.placeholders();
      const blobs = (await manager.query(
        `SELECT reference_count AS count FROM blob WHERE id = ${ph.bind(id)} AND namespace_id = ${ph.bind(namespaceId)}`,
        ph.params,
      )) as { count: number }[];
      if (!blobs[0] || blobs[0].count < count) throw new DataInconsistencyError('Blob 참조 수 불일치');
      await this.blobs.decrementReferenceCount(manager, id, count);
    }
  }

  /** root를 제외한 leaf를 최대 500행씩 제거하고 같은 트랜잭션에서 직접 정산한다. */
  async removeLeafNodes(namespaceId: string, limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid cleanup limit');
    return this.locked(namespaceId, 'METADATA', 0, async ({ manager }) => {
      const ph = this.placeholders();
      const rows = (await manager.query(
        `SELECT n.id, n.type, n.blob_id AS "blobId", CAST(n.size AS TEXT) AS size FROM vfs_node n
        WHERE n.namespace_id = ${ph.bind(namespaceId)} AND n.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM vfs_node c WHERE c.namespace_id = n.namespace_id AND c.parent_id = n.id)
        ORDER BY n.id LIMIT ${ph.bind(limit)}`,
        ph.params,
      )) as ContentRow[];
      if (!rows.length) return 0;
      await manager.delete(
        VfsNodeEntity,
        rows.map((row) => row.id),
      );
      await this.releaseReferences(manager, namespaceId, rows);
      await this.debit(manager, namespaceId, {
        live_node_count: BigInt(rows.length),
        live_file_byte_count: rows.reduce(
          (sum, row) => sum + (row.type === 'FILE' ? BigInt(row.size!) : 0n),
          0n,
        ),
      });
      return rows.length;
    });
  }

  private async removeManifest(namespaceId: string, kind: 'snapshot' | 'trash'): Promise<boolean> {
    return this.locked(namespaceId, 'METADATA', false, async ({ manager }) => {
      const ph = this.placeholders();
      const manifests = (await manager.query(
        `SELECT id, CAST(node_count AS TEXT) AS nodes, CAST(logical_bytes AS TEXT) AS bytes FROM vfs_${kind} WHERE namespace_id = ${ph.bind(namespaceId)} ORDER BY id LIMIT 1`,
        ph.params,
      )) as { id: string; nodes: string; bytes: string }[];
      if (!manifests[0]) return false;
      const manifest = manifests[0];
      const entryPh = this.placeholders();
      const entries = (await manager.query(
        `SELECT id, type, blob_id AS "blobId", CAST(size AS TEXT) AS size FROM vfs_${kind}_entry WHERE namespace_id = ${entryPh.bind(namespaceId)} AND ${kind}_id = ${entryPh.bind(manifest.id)}`,
        entryPh.params,
      )) as ContentRow[];
      const bytes = entries.reduce(
        (sum, row) => sum + (row.type === 'FILE' ? BigInt(row.size ?? '0') : 0n),
        0n,
      );
      if (BigInt(entries.length) !== BigInt(manifest.nodes) || bytes !== BigInt(manifest.bytes))
        throw new DataInconsistencyError(`${kind} manifest 불일치`);
      const del = this.placeholders();
      await manager.query(
        `DELETE FROM vfs_${kind} WHERE id = ${del.bind(manifest.id)} AND namespace_id = ${del.bind(namespaceId)}`,
        del.params,
      );
      await this.releaseReferences(manager, namespaceId, entries);
      await this.debit(manager, namespaceId, {
        [`retained_${kind}_node_count`]: BigInt(manifest.nodes),
        [`retained_${kind}_byte_count`]: bytes,
      });
      return true;
    });
  }

  /** snapshot manifest 한 개와 전체 entry를 함께 제거한다. */
  async removeOneSnapshot(namespaceId: string): Promise<boolean> {
    return this.removeManifest(namespaceId, 'snapshot');
  }

  /** 휴지통 정책과 무관하게 manifest 한 개를 영구 제거한다. */
  async removeOneTrash(namespaceId: string): Promise<boolean> {
    return this.removeManifest(namespaceId, 'trash');
  }

  /** VFS mutation receipt만 제거하고 관리자 receipt는 보존한다. */
  async removeMutationReceipts(namespaceId: string): Promise<number> {
    return this.locked(namespaceId, 'METADATA', 0, async ({ manager }) => {
      const count = await this.count(manager, 'vfs_mutation_receipt', namespaceId);
      const ph = this.placeholders();
      await manager.query(
        `DELETE FROM vfs_mutation_receipt WHERE namespace_id = ${ph.bind(namespaceId)}`,
        ph.params,
      );
      return count;
    });
  }

  private async count(
    manager: EntityManager,
    table: string,
    namespaceId: string,
    extra = '',
  ): Promise<number> {
    const ph = this.placeholders();
    const rows = (await manager.query(
      `SELECT COUNT(*) AS count FROM ${table} WHERE namespace_id = ${ph.bind(namespaceId)} ${extra}`,
      ph.params,
    )) as { count: string | number }[];
    return Number(rows[0].count);
  }

  /** root를 제외한 live·snapshot·trash의 남은 개수를 읽는다. */
  async countRemainingMetadata(
    namespaceId: string,
  ): Promise<{ nodes: number; snapshots: number; trash: number }> {
    return {
      nodes: await this.count(this.dataSource.manager, 'vfs_node', namespaceId, 'AND parent_id IS NOT NULL'),
      snapshots: await this.count(this.dataSource.manager, 'vfs_snapshot', namespaceId),
      trash: await this.count(this.dataSource.manager, 'vfs_trash', namespaceId),
    };
  }

  /** grace가 지난 미삭제 Blob과 아직 기다려야 하는 Blob을 구분한다. */
  async inspectObjects(
    namespaceId: string,
    cutoff: Date,
  ): Promise<{ referenced: number; overdue: number; pending: number }> {
    const ph = this.placeholders();
    const value = isSqliteDataSource(this.dataSource.options)
      ? cutoff.toISOString().slice(0, 19).replace('T', ' ')
      : cutoff;
    const rows = (await this.dataSource.query(
      `SELECT reference_count AS refs, CASE WHEN zero_since < ${ph.bind(value)} THEN 1 ELSE 0 END AS overdue FROM blob WHERE namespace_id = ${ph.bind(namespaceId)}`,
      ph.params,
    )) as { refs: number; overdue: number }[];
    return {
      referenced: rows.filter((row) => row.refs > 0).length,
      overdue: rows.filter((row) => row.refs === 0 && row.overdue === 1).length,
      pending: rows.filter((row) => row.refs === 0 && row.overdue === 0).length,
    };
  }

  /** SQLite에서도 64-bit byte counter를 반올림하지 않고 읽는다. */
  async readCounters(
    namespaceId: string,
    manager = this.dataSource.manager,
  ): Promise<Record<'live' | 'liveNodes' | 'snapNodes' | 'snapBytes' | 'trashNodes' | 'trashBytes', string>> {
    const ph = this.placeholders();
    const rows = await manager.query(
      `SELECT CAST(live_file_byte_count AS TEXT) AS live, CAST(live_node_count AS TEXT) AS "liveNodes", CAST(retained_snapshot_node_count AS TEXT) AS "snapNodes", CAST(retained_snapshot_byte_count AS TEXT) AS "snapBytes", CAST(retained_trash_node_count AS TEXT) AS "trashNodes", CAST(retained_trash_byte_count AS TEXT) AS "trashBytes" FROM namespace WHERE id = ${ph.bind(namespaceId)}`,
      ph.params,
    );
    if (!rows[0]) throw new DataInconsistencyError('namespace 누락');
    return rows[0];
  }

  /** root → usage 잠금 안에서 모든 완료 조건을 재검사하고 tombstone으로 전환한다. */
  async complete(namespaceId: string, now: Date): Promise<boolean> {
    return this.locked(namespaceId, 'OBJECTS', false, async ({ manager, rootId }) => {
      await this.uploads.lockUsageForNamespace(manager, namespaceId);
      for (const table of [
        'blob',
        'vfs_upload_session',
        'vfs_upload_staging_cleanup',
        'vfs_snapshot',
        'vfs_trash',
      ])
        if (await this.count(manager, table, namespaceId)) return false;
      if (await this.count(manager, 'vfs_node', namespaceId, 'AND parent_id IS NOT NULL')) return false;
      const usage = await this.uploads.readNamespaceUsage(namespaceId, manager);
      if (
        [...Object.values(await this.readCounters(namespaceId, manager)), ...Object.values(usage)].some(
          (value) => BigInt(value) !== 0n,
        )
      )
        throw new DataInconsistencyError('완료 counter 불일치');
      await manager.delete(VfsNodeEntity, { id: rootId, namespaceId });
      await manager.update(NamespaceEntity, { id: namespaceId }, { status: 'DELETED' });
      await manager.update(
        NamespaceDeletionEntity,
        { namespaceId, phase: 'OBJECTS' },
        { phase: 'COMPLETED', completedAt: now, updatedAt: now, blockedReason: null },
      );
      return true;
    });
  }
}
