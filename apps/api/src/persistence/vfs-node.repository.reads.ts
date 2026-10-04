import { EntityManager, IsNull } from 'typeorm';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { KeysetCursor } from '../common/keyset-cursor.js';
import { encodeRevision } from '../vfs/revision.js';
import { toPreconditionCurrent, VfsPreconditionCurrentDto } from '../vfs/dto/node-response.dto.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import {
  VfsInvalidCursorError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsPreconditionFailedError,
} from '../vfs/vfs.errors.js';
import { BlobEntity } from './entities/blob.entity.js';
import { VfsNodeEntity, VfsNodeType } from './entities/vfs-node.entity.js';
import { RevisionCursor } from '../vfs/revision-cursor.js';
import type {
  VfsNodeRecord,
  VfsContentBlobRef,
  NamespaceResourceLimits,
  VfsNodeMatch,
  FindFilter,
  FindRecursiveRow,
} from './vfs-node.repository.types.js';
import { toRecord, toMatch, buildLikePattern } from './vfs-node.repository.helpers.js';
import { VfsNodeRepositoryCore } from './vfs-node.repository.core.js';

export class VfsNodeRepositoryReads extends VfsNodeRepositoryCore {
  @classifyPersistenceOperation
  async getRoot(namespaceId: string): Promise<VfsNodeRecord | null> {
    const namespace = await this.namespaceRepo.findOneBy({ id: namespaceId });
    if (!namespace || namespace.status !== 'ACTIVE') {
      return null;
    }

    const root = await this.nodeRepo.findOneBy({ namespaceId, parentId: IsNull() });
    return root ? toRecord(root) : null;
  }

  @classifyPersistenceOperation
  async getRootWithLimits(
    namespaceId: string,
  ): Promise<{ root: VfsNodeRecord; limits: NamespaceResourceLimits } | null> {
    const namespace = await this.namespaceRepo.findOneBy({ id: namespaceId });
    if (!namespace || namespace.status !== 'ACTIVE') {
      return null;
    }

    const root = await this.nodeRepo.findOneBy({ namespaceId, parentId: IsNull() });
    if (!root) {
      return null;
    }

    return {
      root: toRecord(root),
      limits: {
        // bigint 컬럼은 NamespaceEntity 타입상 항상 string이지만, SQLite에서
        // Repository.update()로 쓴 값을 다시 읽으면(save() 경로와 달리)
        // better-sqlite3가 raw number를 그대로 돌려준다 — String()으로
        // 명시적으로 맞춘다(parseSqlTimestamp와 동일한 이유의 방어적 보정).
        maxFileSizeBytes: namespace.maxFileSizeBytes === null ? null : String(namespace.maxFileSizeBytes),
        maxSyncDeleteNodes: namespace.maxSyncDeleteNodes,
        maxSyncCopyNodes: namespace.maxSyncCopyNodes,
        maxSyncMoveNodes: namespace.maxSyncMoveNodes,
        encryptionPolicy: namespace.encryptionPolicy,
        accessPolicy: namespace.accessPolicy,
      },
    };
  }

  @classifyPersistenceOperation
  async resolvePath(namespaceId: string, rootId: string, segments: string[]): Promise<VfsNodeRecord | null> {
    let parentId = rootId;
    let parentType: VfsNodeType = 'DIRECTORY';
    let node: VfsNodeEntity | null = null;

    for (const segment of segments) {
      if (parentType !== 'DIRECTORY') {
        return null;
      }

      node = await this.nodeRepo.findOneBy({ namespaceId, parentId, name: segment });
      if (!node) {
        return null;
      }

      parentId = node.id;
      parentType = node.type;
    }

    return node ? toRecord(node) : null;
  }

  private readSnapshot<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.isSqlite
      ? this.dataSource.transaction(work)
      : this.dataSource.transaction('REPEATABLE READ', work);
  }

  @classifyPersistenceOperation
  async readRevision(namespaceId: string, rootId: string, segments: string[]): Promise<VfsNodeRecord | null> {
    return this.readSnapshot(async (manager) => {
      const node = await this.resolvePathInManager(manager, namespaceId, rootId, segments);
      return node ? toRecord(node) : null;
    });
  }

  @classifyPersistenceOperation
  async readStat(
    namespaceId: string,
    rootId: string,
    segments: string[],
  ): Promise<{ node: VfsNodeRecord; sha256: string | null } | null> {
    const read = await this.readContentFile(namespaceId, rootId, segments);
    return read ? { node: read.node, sha256: read.blob?.sha256 ?? null } : null;
  }

  @classifyPersistenceOperation
  async readContentFile(
    namespaceId: string,
    rootId: string,
    segments: string[],
  ): Promise<{ node: VfsNodeRecord; blob: VfsContentBlobRef | null } | null> {
    return this.readSnapshot(async (manager) => {
      const node = await this.resolvePathInManager(manager, namespaceId, rootId, segments);
      if (!node) return null;
      if (node.type === 'DIRECTORY') return { node: toRecord(node), blob: null };
      if (!node.blobId) throw new Error('FILE node에 blobId가 없음 — 데이터 일관성 위반');
      const blob = await manager.getRepository(BlobEntity).findOneBy({ id: node.blobId, namespaceId });
      if (!blob) throw new Error('FILE node가 참조하는 Blob이 없음 — 데이터 일관성 위반');
      return {
        node: toRecord(node),
        blob: { storageKey: blob.storageKey, encryptionIv: blob.encryptionIv, sha256: blob.sha256 },
      };
    });
  }

  @classifyPersistenceOperation
  async listRevisionChildren(
    namespaceId: string,
    rootId: string,
    segments: string[],
    canonicalPath: string,
    cursor: RevisionCursor | null,
    limit: number,
  ): Promise<{ directory: VfsNodeRecord; rows: VfsNodeRecord[] }> {
    return this.readSnapshot(async (manager) => {
      const directory = await this.resolvePathInManager(manager, namespaceId, rootId, segments);
      if (!directory) throw new VfsNodeNotFoundError(canonicalPath);
      if (directory.type !== 'DIRECTORY') throw new VfsNotDirectoryError(canonicalPath);
      if (cursor?.directoryId !== undefined && cursor.directoryId !== directory.id) {
        throw new VfsInvalidCursorError('directory mismatch');
      }
      if (cursor && cursor.directoryRevision !== encodeRevision(directory)) {
        throw new VfsPreconditionFailedError(canonicalPath, this.currentOf(directory, canonicalPath));
      }
      const qb = manager
        .getRepository(VfsNodeEntity)
        .createQueryBuilder('n')
        .where('n.namespace_id = :namespaceId AND n.parent_id = :parentId', {
          namespaceId,
          parentId: directory.id,
        })
        .orderBy('n.name', 'ASC')
        .addOrderBy('n.id', 'ASC')
        .take(limit + 1);
      if (cursor) {
        qb.andWhere('(n.name, n.id) > (:cursorName, :cursorId)', {
          cursorName: cursor.name,
          cursorId: cursor.id,
        });
      }
      const rows = await qb.getMany();
      return { directory: toRecord(directory), rows: rows.map(toRecord) };
    });
  }

  @classifyPersistenceOperation
  async listChildren(
    namespaceId: string,
    parentId: string,
    cursor: KeysetCursor | null,
    limit: number,
  ): Promise<VfsNodeRecord[]> {
    const qb = this.nodeRepo
      .createQueryBuilder('n')
      .where('n.namespace_id = :namespaceId', { namespaceId })
      .andWhere('n.parent_id = :parentId', { parentId })
      .orderBy('n.name', 'ASC')
      .addOrderBy('n.id', 'ASC')
      .take(limit + 1);

    if (cursor) {
      qb.andWhere('(n.name, n.id) > (:cursorName, :cursorId)', {
        cursorName: cursor.name,
        cursorId: cursor.id,
      });
    }

    const rows = await qb.getMany();
    return rows.map(toRecord);
  }

  @classifyPersistenceOperation
  async findRecursive(
    namespaceId: string,
    startId: string,
    filter: FindFilter,
    cursor: KeysetCursor | null,
    limit: number,
  ): Promise<VfsNodeMatch[]> {
    const ph = new DialectPlaceholders(this.isSqlite);

    let sql = `
      WITH RECURSIVE subtree AS (
        SELECT id, namespace_id, parent_id, type, name, blob_id, size, mime_type, created_at, updated_at, version,
               expires_at, CAST(name AS TEXT) AS path_segments
        FROM vfs_node
        WHERE namespace_id = ${ph.bind(namespaceId)} AND parent_id = ${ph.bind(startId)}
        UNION ALL
        SELECT vn.id, vn.namespace_id, vn.parent_id, vn.type, vn.name, vn.blob_id, vn.size, vn.mime_type,
               vn.created_at, vn.updated_at, vn.version, vn.expires_at, s.path_segments || '/' || vn.name
        FROM vfs_node vn
        INNER JOIN subtree s ON vn.namespace_id = s.namespace_id AND vn.parent_id = s.id
      )
      SELECT * FROM subtree WHERE 1 = 1
    `;

    if (filter.type) {
      sql += ` AND type = ${ph.bind(filter.type)}`;
    }

    if (filter.name) {
      if (filter.name.mode === 'exact') {
        sql += ` AND name = ${ph.bind(filter.name.value)}`;
      } else {
        sql += ` AND name LIKE ${ph.bind(buildLikePattern(filter.name.mode, filter.name.value))} ESCAPE '\\'`;
      }
    }

    if (cursor) {
      const namePlaceholder = ph.bind(cursor.name);
      const idPlaceholder = ph.bind(cursor.id);
      sql += ` AND (name, id) > (${namePlaceholder}, ${idPlaceholder})`;
    }

    sql += ` ORDER BY name ASC, id ASC LIMIT ${ph.bind(limit + 1)}`;

    const rows: FindRecursiveRow[] = await this.dataSource.query(sql, ph.params);
    return rows.map(toMatch);
  }

  // 412 body의 current. stat 응답 필드에 revision을 더한 shape이며, 트랜잭션 안에서 읽은 엔티티로 만든다.
  protected currentOf(node: VfsNodeEntity | null, path: string): VfsPreconditionCurrentDto | null {
    return node ? toPreconditionCurrent(toRecord(node), path) : null;
  }
}
