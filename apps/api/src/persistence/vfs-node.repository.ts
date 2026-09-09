import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { KeysetCursor } from '../common/keyset-cursor.js';
import {
  VfsAlreadyExistsError,
  VfsCopyLimitExceededError,
  VfsDeleteLimitExceededError,
  VfsDirectoryNotEmptyError,
  VfsInvalidOperationError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsVersionConflictError,
} from '../vfs/vfs.errors.js';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { EncryptionPolicy, NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity, VfsNodeType } from './entities/vfs-node.entity.js';

export interface VfsNodeRecord {
  readonly id: string;
  readonly name: string;
  readonly type: VfsNodeType;
  readonly blobId: string | null;
  readonly size: string | null;
  readonly mimeType: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface NamespaceResourceLimits {
  readonly maxFileSizeBytes: string | null;
  readonly maxSyncDeleteNodes: number | null;
  readonly maxSyncCopyNodes: number | null;
  readonly encryptionPolicy: EncryptionPolicy;
}

export interface VfsNodeMatch extends VfsNodeRecord {
  readonly relativeSegments: string[];
}

export type NameFilterMode = 'exact' | 'contains' | 'prefix' | 'suffix';

export interface FindFilter {
  readonly name?: { readonly mode: NameFilterMode; readonly value: string };
  readonly type?: VfsNodeType;
}

export interface BlobData {
  readonly storageKey: string;
  readonly size: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly encryptionIv: Buffer | null;
}

export type PutFileOutcome =
  | { readonly kind: 'created'; readonly node: VfsNodeRecord }
  | { readonly kind: 'replaced'; readonly node: VfsNodeRecord };

interface FindRecursiveRow {
  readonly id: string;
  readonly name: string;
  readonly type: VfsNodeType;
  readonly blob_id: string | null;
  readonly size: string | null;
  readonly mime_type: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly version: number;
  readonly path_segments: string;
}

interface CopySourceRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly type: VfsNodeType;
  readonly name: string;
  readonly blob_id: string | null;
  readonly size: string | null;
  readonly mime_type: string | null;
}

function toRecord(entity: VfsNodeEntity): VfsNodeRecord {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    blobId: entity.blobId,
    size: entity.size,
    mimeType: entity.mimeType,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    version: entity.version,
  };
}

// raw SQL 경로는 TypeORM의 엔티티 하이드레이션을 안 거치므로, SQLite
// 드라이버가 돌려주는 "2026-09-08 23:02:01" 같은 공백 구분·타임존 없는
// 문자열을 Date로 그냥 넘기면 V8이 로컬 타임존으로 해석해버린다(Postgres는
// 이미 Date 객체를 돌려주므로 이 문제가 없다). TypeORM의
// AbstractSqliteDriver.prepareHydratedValue가 엔티티 경로에서 하는 것과
// 같은 보정을 적용해 항상 UTC로 해석되게 한다.
function parseSqlTimestamp(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }
  let normalized = value;
  if (/^\d\d\d\d-\d\d-\d\d \d\d:\d\d/.test(normalized)) {
    normalized = normalized.replace(' ', 'T');
  }
  if (/^\d\d\d\d-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(normalized)) {
    normalized += 'Z';
  }
  return new Date(normalized);
}

function toMatch(row: FindRecursiveRow): VfsNodeMatch {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    blobId: row.blob_id,
    size: row.size,
    mimeType: row.mime_type,
    createdAt: parseSqlTimestamp(row.created_at),
    updatedAt: parseSqlTimestamp(row.updated_at),
    version: row.version,
    relativeSegments: row.path_segments.split('/'),
  };
}

function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function buildLikePattern(mode: NameFilterMode, value: string): string {
  const escaped = escapeLikeValue(value);
  switch (mode) {
    case 'contains':
      return `%${escaped}%`;
    case 'prefix':
      return `${escaped}%`;
    case 'suffix':
      return `%${escaped}`;
    default:
      return escaped;
  }
}

function joinSegments(segments: string[]): string {
  return `/${segments.join('/')}`;
}

// segment 배열에 대한 사전식(lexicographic) 전역 순서. 한쪽이 다른 쪽의 prefix이면
// 더 짧은 쪽이 먼저 온다. joinSegments로 합친 path 문자열 비교는 이 순서의 유효한
// 대용물이 아니므로(예: '/a' <= '/a.b/x'는 true지만 '/a.b' <= '/a/y'도 true — '.'이
// '/'보다 ASCII상 앞이라 발생하는 모순) 트리 구조상의 순서가 필요한 곳에서는 반드시
// 이 함수처럼 segment 단위로 비교해야 한다.
function compareSegments(a: readonly string[], b: readonly string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

@Injectable()
export class VfsNodeRepository {
  constructor(
    @InjectRepository(NamespaceEntity) private readonly namespaceRepo: Repository<NamespaceEntity>,
    @InjectRepository(VfsNodeEntity) private readonly nodeRepo: Repository<VfsNodeEntity>,
    @InjectRepository(BlobEntity) private readonly blobRepo: Repository<BlobEntity>,
    private readonly dataSource: DataSource,
    private readonly blobRepository: BlobRepository,
  ) {}

  async getRoot(namespaceId: string): Promise<VfsNodeRecord | null> {
    const namespace = await this.namespaceRepo.findOneBy({ id: namespaceId });
    if (!namespace) {
      return null;
    }

    const root = await this.nodeRepo.findOneBy({ namespaceId, parentId: IsNull() });
    return root ? toRecord(root) : null;
  }

  async getRootWithLimits(
    namespaceId: string,
  ): Promise<{ root: VfsNodeRecord; limits: NamespaceResourceLimits } | null> {
    const namespace = await this.namespaceRepo.findOneBy({ id: namespaceId });
    if (!namespace) {
      return null;
    }

    const root = await this.nodeRepo.findOneBy({ namespaceId, parentId: IsNull() });
    if (!root) {
      return null;
    }

    return {
      root: toRecord(root),
      limits: {
        maxFileSizeBytes: namespace.maxFileSizeBytes,
        maxSyncDeleteNodes: namespace.maxSyncDeleteNodes,
        maxSyncCopyNodes: namespace.maxSyncCopyNodes,
        encryptionPolicy: namespace.encryptionPolicy,
      },
    };
  }

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

  async findRecursive(
    namespaceId: string,
    startId: string,
    filter: FindFilter,
    cursor: KeysetCursor | null,
    limit: number,
  ): Promise<VfsNodeMatch[]> {
    const isSqlite = this.dataSource.options.type === 'better-sqlite3';
    const params: unknown[] = [];
    // Postgres '$N'은 위치 무관 이름 기반 파라미터(재사용 가능)라 params.length
    // 기준으로 번호를 매기면 되지만, SQLite '?'는 텍스트 등장 순서로 바인딩되고
    // 재사용이 안 된다. push와 동시에 알맞은 플레이스홀더 문자열을 만들어 두
    // 드라이버 모두에서 파라미터 순서가 어긋나지 않게 한다.
    const ph = (value: unknown): string => {
      params.push(value);
      return isSqlite ? '?' : `$${params.length}`;
    };

    let sql = `
      WITH RECURSIVE subtree AS (
        SELECT id, namespace_id, parent_id, type, name, blob_id, size, mime_type, created_at, updated_at, version,
               CAST(name AS TEXT) AS path_segments
        FROM vfs_node
        WHERE namespace_id = ${ph(namespaceId)} AND parent_id = ${ph(startId)}
        UNION ALL
        SELECT vn.id, vn.namespace_id, vn.parent_id, vn.type, vn.name, vn.blob_id, vn.size, vn.mime_type,
               vn.created_at, vn.updated_at, vn.version, s.path_segments || '/' || vn.name
        FROM vfs_node vn
        INNER JOIN subtree s ON vn.namespace_id = s.namespace_id AND vn.parent_id = s.id
      )
      SELECT * FROM subtree WHERE 1 = 1
    `;

    if (filter.type) {
      sql += ` AND type = ${ph(filter.type)}`;
    }

    if (filter.name) {
      if (filter.name.mode === 'exact') {
        sql += ` AND name = ${ph(filter.name.value)}`;
      } else {
        sql += ` AND name LIKE ${ph(buildLikePattern(filter.name.mode, filter.name.value))} ESCAPE '\\'`;
      }
    }

    if (cursor) {
      const namePlaceholder = ph(cursor.name);
      const idPlaceholder = ph(cursor.id);
      sql += ` AND (name, id) > (${namePlaceholder}, ${idPlaceholder})`;
    }

    sql += ` ORDER BY name ASC, id ASC LIMIT ${ph(limit + 1)}`;

    const rows: FindRecursiveRow[] = await this.dataSource.query(sql, params);
    return rows.map(toMatch);
  }

  async ensureDirectory(
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
  ): Promise<{ node: VfsNodeRecord; created: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const nodeRepo = manager.getRepository(VfsNodeEntity);
      let parentId = rootId;
      let parentType: VfsNodeType = 'DIRECTORY';
      let created = false;
      let current: VfsNodeEntity | null = null;

      for (let i = 0; i < segments.length; i += 1) {
        const name = segments[i];
        const isLast = i === segments.length - 1;

        if (parentType !== 'DIRECTORY') {
          throw new VfsNotDirectoryError(joinSegments(segments.slice(0, i)));
        }

        await this.applyRowLockIfSupported(
          manager.createQueryBuilder(VfsNodeEntity, 'n').where('n.id = :id', { id: parentId }),
        ).getOne();

        let child = await nodeRepo.findOneBy({ namespaceId, parentId, name });

        if (child) {
          if (isLast && (child.type === 'FILE' || !parents)) {
            throw new VfsAlreadyExistsError(joinSegments(segments));
          }
        } else {
          if (!isLast && !parents) {
            throw new VfsNodeNotFoundError(joinSegments(segments.slice(0, i + 1)));
          }
          child = await nodeRepo.save(nodeRepo.create({ namespaceId, parentId, type: 'DIRECTORY', name }));
          if (isLast) {
            created = true;
          }
        }

        current = child;
        parentId = child.id;
        parentType = child.type;
      }

      return { node: toRecord(current as VfsNodeEntity), created };
    });
  }

  async touchFile(
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
    emptyBlob: BlobData,
  ): Promise<PutFileOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const nodeRepo = manager.getRepository(VfsNodeEntity);
      const blobRepo = manager.getRepository(BlobEntity);
      const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, parents);
      const name = segments[segments.length - 1];

      const existing = await this.lockTargetNode(manager, namespaceId, parentId, name);

      if (existing) {
        if (existing.type === 'DIRECTORY') {
          throw new VfsIsDirectoryError(joinSegments(segments));
        }
        // content는 그대로 두고 updatedAt만 갱신해 diff를 발생시킨다.
        // TypeORM은 변경된 column이 없으면 UPDATE 자체를 생략해 @VersionColumn도
        // 증가하지 않으므로, save()만 호출해서는 touch의 "version만 올린다" 요구를 만족할 수 없다.
        existing.updatedAt = new Date();
        const touched = await nodeRepo.save(existing);
        return { kind: 'replaced', node: toRecord(touched) };
      }

      const blob = await blobRepo.save(blobRepo.create({ namespaceId, ...emptyBlob, referenceCount: 1 }));
      const created = await nodeRepo.save(
        nodeRepo.create({
          namespaceId,
          parentId,
          type: 'FILE',
          name,
          blobId: blob.id,
          size: emptyBlob.size,
          mimeType: emptyBlob.mimeType,
        }),
      );

      return { kind: 'created', node: toRecord(created) };
    });
  }

  async putFileContent(
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
    newBlob: BlobData,
    ifMatchVersion: number | null,
    force: boolean,
  ): Promise<PutFileOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const nodeRepo = manager.getRepository(VfsNodeEntity);
      const blobRepo = manager.getRepository(BlobEntity);
      const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, parents);
      const name = segments[segments.length - 1];

      const existing = await this.lockTargetNode(manager, namespaceId, parentId, name);

      if (existing) {
        if (existing.type === 'DIRECTORY') {
          throw new VfsIsDirectoryError(joinSegments(segments));
        }
        if (!force && (ifMatchVersion === null || ifMatchVersion !== existing.version)) {
          throw new VfsVersionConflictError(joinSegments(segments));
        }

        const createdBlob = await blobRepo.save(
          blobRepo.create({ namespaceId, ...newBlob, referenceCount: 1 }),
        );
        if (existing.blobId === null) {
          throw new Error('FILE node에 blobId가 없음 — 데이터 일관성 위반');
        }
        const previousBlobId = existing.blobId;

        existing.blobId = createdBlob.id;
        existing.size = newBlob.size;
        existing.mimeType = newBlob.mimeType;
        const saved = await nodeRepo.save(existing);

        await this.blobRepository.decrementReferenceCount(manager, previousBlobId, 1);

        return { kind: 'replaced', node: toRecord(saved) };
      }

      const createdBlob = await blobRepo.save(
        blobRepo.create({ namespaceId, ...newBlob, referenceCount: 1 }),
      );
      const created = await nodeRepo.save(
        nodeRepo.create({
          namespaceId,
          parentId,
          type: 'FILE',
          name,
          blobId: createdBlob.id,
          size: newBlob.size,
          mimeType: newBlob.mimeType,
        }),
      );

      return { kind: 'created', node: toRecord(created) };
    });
  }

  private async resolveDestinationPlacement(
    manager: EntityManager,
    namespaceId: string,
    rootId: string,
    sourceSegments: string[],
    destinationSegments: string[],
    destinationParents: boolean,
  ): Promise<{
    sourceNode: VfsNodeEntity;
    finalParentId: string;
    finalName: string;
    finalSegments: string[];
  }> {
    const resolveSource = async (): Promise<VfsNodeEntity> => {
      const parentId = await this.lockParentChain(manager, namespaceId, rootId, sourceSegments, false);
      const name = sourceSegments[sourceSegments.length - 1];
      const node = await this.lockTargetNode(manager, namespaceId, parentId, name);
      if (!node) {
        throw new VfsNodeNotFoundError(joinSegments(sourceSegments));
      }
      return node;
    };

    const resolveDestinationParent = () =>
      this.lockParentChain(manager, namespaceId, rootId, destinationSegments, destinationParents);

    // source/destination의 조상 chain이 겹칠 수 있어, 한 트랜잭션 안에서 두 path를
    // 잠그는 순서가 호출마다 뒤바뀌면 반대 방향으로 동시에 실행되는 mv/cp끼리 교착
    // 상태에 빠질 수 있다. 이를 막으려면 모든 트랜잭션이 동일한 전역 순서로 두
    // path를 잠가야 하며, 그 순서는 반드시 segment 배열의 사전식 비교여야 한다
    // (compareSegments 참고) — joinSegments로 합친 path 문자열 비교는 유효한
    // 대용물이 아니다. 예를 들어 '/a' <= '/a.b/x'는 true인데 '/a.b' <= '/a/y'도
    // '.'이 '/'보다 ASCII상 앞이라 true가 되어, 서로 무관한 두 연산
    // (`mv /a /a.b/x`, `mv /a.b /a/y`)이 각자 반대 순서로 a/a.b를 잠그게 된다.
    //
    // 다만 lockParentChain이 매 호출마다 namespace root를 무조건 가장 먼저 잠그기
    // 때문에, 같은 namespace를 다루는 모든 트랜잭션은 이미 그 root row lock 하나로
    // 완전히 직렬화되어 있어 이 순서 자체는 현재 실질적으로 불필요하다. 그럼에도
    // 구조적으로 올바른 lock 순서를 유지해 두면, 이후 root 단위 locking을 더 세밀한
    // 단위로 좁히더라도 이 코드가 계속 정확하다.
    let sourceNode: VfsNodeEntity;
    let destinationParentId: string;

    if (compareSegments(sourceSegments, destinationSegments) <= 0) {
      sourceNode = await resolveSource();
      destinationParentId = await resolveDestinationParent();
    } else {
      destinationParentId = await resolveDestinationParent();
      sourceNode = await resolveSource();
    }

    const destinationName =
      destinationSegments.length === 0 ? null : destinationSegments[destinationSegments.length - 1];
    const destinationTarget = destinationName
      ? await this.lockTargetNode(manager, namespaceId, destinationParentId, destinationName)
      : null;

    const nestUnderDirectory = destinationSegments.length === 0 || destinationTarget?.type === 'DIRECTORY';
    const sourceBasename = sourceSegments[sourceSegments.length - 1];

    const finalParentId = nestUnderDirectory
      ? destinationSegments.length === 0
        ? destinationParentId
        : (destinationTarget as VfsNodeEntity).id
      : destinationParentId;
    const finalName = nestUnderDirectory ? sourceBasename : (destinationName as string);
    const finalSegments = nestUnderDirectory
      ? [...destinationSegments, sourceBasename]
      : destinationSegments;

    // "directory를 자신 또는 자기 subtree 아래로 move/copy" 금지는 spec상 directory에만
    // 적용된다(file은 자기 경로 자신을 "목적지"로 지정해도 일반 충돌로 취급).
    if (
      sourceNode.type === 'DIRECTORY' &&
      finalSegments.length >= sourceSegments.length &&
      sourceSegments.every((segment, index) => finalSegments[index] === segment)
    ) {
      throw new VfsInvalidOperationError(joinSegments(sourceSegments));
    }

    if (nestUnderDirectory) {
      const collision = await this.lockTargetNode(manager, namespaceId, finalParentId, finalName);
      if (collision) {
        throw new VfsAlreadyExistsError(joinSegments(finalSegments));
      }
    } else if (destinationTarget) {
      throw new VfsAlreadyExistsError(joinSegments(destinationSegments));
    }

    return { sourceNode, finalParentId, finalName, finalSegments };
  }

  async moveNode(
    namespaceId: string,
    rootId: string,
    sourceSegments: string[],
    destinationSegments: string[],
    destinationParents: boolean,
  ): Promise<{ node: VfsNodeRecord; finalPath: string }> {
    return this.dataSource.transaction(async (manager) => {
      const { sourceNode, finalParentId, finalName, finalSegments } = await this.resolveDestinationPlacement(
        manager,
        namespaceId,
        rootId,
        sourceSegments,
        destinationSegments,
        destinationParents,
      );

      sourceNode.parentId = finalParentId;
      sourceNode.name = finalName;
      const saved = await manager.getRepository(VfsNodeEntity).save(sourceNode);

      return { node: toRecord(saved), finalPath: joinSegments(finalSegments) };
    });
  }

  async removeEmptyDirectory(namespaceId: string, rootId: string, segments: string[]): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, false);
      const name = segments[segments.length - 1];
      const target = await this.lockTargetNode(manager, namespaceId, parentId, name);

      if (!target) {
        throw new VfsNodeNotFoundError(joinSegments(segments));
      }
      if (target.type === 'FILE') {
        throw new VfsNotDirectoryError(joinSegments(segments));
      }

      const childCount = await manager
        .createQueryBuilder(VfsNodeEntity, 'n')
        .where('n.namespace_id = :namespaceId', { namespaceId })
        .andWhere('n.parent_id = :parentId', { parentId: target.id })
        .getCount();

      if (childCount > 0) {
        throw new VfsDirectoryNotEmptyError(joinSegments(segments));
      }

      await manager.getRepository(VfsNodeEntity).remove(target);
    });
  }

  async removeNode(
    namespaceId: string,
    rootId: string,
    segments: string[],
    recursive: boolean,
    maxSyncDeleteNodes: number,
  ): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      const nodeRepo = manager.getRepository(VfsNodeEntity);
      const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, false);
      const name = segments[segments.length - 1];
      const target = await this.lockTargetNode(manager, namespaceId, parentId, name);

      if (!target) {
        throw new VfsNodeNotFoundError(joinSegments(segments));
      }

      if (target.type === 'FILE') {
        if (!target.blobId) {
          throw new Error('FILE node에 blobId가 없음 — 데이터 일관성 위반');
        }
        await nodeRepo.remove(target);
        await this.blobRepository.decrementReferenceCount(manager, target.blobId, 1);
        return;
      }

      if (!recursive) {
        throw new VfsIsDirectoryError(joinSegments(segments));
      }

      // target 자신의 row lock을 이미 보유하고 있어 이 subtree 안팎으로의 모든
      // insert/rename/delete는 target을 잠그려다 대기한다(lockParentChain은 항상
      // root부터 순서대로 잠그므로 target 하위 어디를 만들려 해도 target을 거친다).
      // 따라서 아래 재귀 조회~삭제 사이에 subtree 구성이 바뀔 수 없다.
      const subtreeRows: { id: string; blob_id: string | null }[] = await manager.query(
        `WITH RECURSIVE subtree AS (
           SELECT id, namespace_id, blob_id FROM vfs_node WHERE namespace_id = $2 AND id = $1
           UNION ALL
           SELECT vn.id, vn.namespace_id, vn.blob_id FROM vfs_node vn
           INNER JOIN subtree s ON vn.namespace_id = s.namespace_id AND vn.parent_id = s.id
         )
         SELECT id, blob_id FROM subtree`,
        [target.id, namespaceId],
      );

      if (subtreeRows.length > maxSyncDeleteNodes) {
        throw new VfsDeleteLimitExceededError(maxSyncDeleteNodes);
      }

      const ids = subtreeRows.map((row) => row.id);
      await this.applyRowLockIfSupported(
        manager.createQueryBuilder(VfsNodeEntity, 'n').where('n.id IN (:...ids)', { ids }).orderBy('n.id', 'ASC'),
      ).getMany();

      const blobDecrements = new Map<string, number>();
      for (const row of subtreeRows) {
        if (row.blob_id) {
          blobDecrements.set(row.blob_id, (blobDecrements.get(row.blob_id) ?? 0) + 1);
        }
      }

      await nodeRepo.delete(ids);

      // CTE 결과의 row 순서는 비결정적이라 Map의 삽입 순서를 그대로 따르면 decrement
      // 호출 순서가 매번 달라진다. 여러 독립적인 row에 대한 write를 한 트랜잭션에서
      // 수행할 때는 고정된 정렬 순서로 처리해 두는 편이 이후 잠재적인 AB-BA 교착의
      // 소지를 없앤다(moveNode의 lock 순서와 동일한 원리).
      const sortedBlobDecrements = [...blobDecrements].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      for (const [blobId, count] of sortedBlobDecrements) {
        await this.blobRepository.decrementReferenceCount(manager, blobId, count);
      }
    });
  }

  async copyNode(
    namespaceId: string,
    rootId: string,
    sourceSegments: string[],
    destinationSegments: string[],
    destinationParents: boolean,
    maxSyncCopyNodes: number,
  ): Promise<{ node: VfsNodeRecord; finalPath: string }> {
    return this.dataSource.transaction(async (manager) => {
      const nodeRepo = manager.getRepository(VfsNodeEntity);
      const blobRepo = manager.getRepository(BlobEntity);

      const { sourceNode, finalParentId, finalName, finalSegments } = await this.resolveDestinationPlacement(
        manager,
        namespaceId,
        rootId,
        sourceSegments,
        destinationSegments,
        destinationParents,
      );

      if (sourceNode.type === 'FILE') {
        if (!sourceNode.blobId) {
          throw new Error('FILE node에 blobId가 없음 — 데이터 일관성 위반');
        }

        // COW: MinIO I/O 없이 같은 Blob을 가리키는 새 Node만 만들고 참조 수를 늘린다.
        await blobRepo.increment({ id: sourceNode.blobId }, 'referenceCount', 1);
        const created = await nodeRepo.save(
          nodeRepo.create({
            namespaceId,
            parentId: finalParentId,
            type: 'FILE',
            name: finalName,
            blobId: sourceNode.blobId,
            size: sourceNode.size,
            mimeType: sourceNode.mimeType,
          }),
        );

        return { node: toRecord(created), finalPath: joinSegments(finalSegments) };
      }

      // DIRECTORY: resolveDestinationPlacement 안에서 source 자신의 row lock을 이미
      // 획득했으므로(removeNode와 동일 원리), 아래 조회~생성 사이에 source subtree
      // 구성이 바뀔 수 없다.
      const subtreeRows: CopySourceRow[] = await manager.query(
        `WITH RECURSIVE subtree AS (
           SELECT id, parent_id, type, name, blob_id, size, mime_type
           FROM vfs_node WHERE namespace_id = $2 AND id = $1
           UNION ALL
           SELECT vn.id, vn.parent_id, vn.type, vn.name, vn.blob_id, vn.size, vn.mime_type
           FROM vfs_node vn
           INNER JOIN subtree s ON vn.namespace_id = $2 AND vn.parent_id = s.id
         )
         SELECT id, parent_id, type, name, blob_id, size, mime_type FROM subtree LIMIT $3`,
        [sourceNode.id, namespaceId, maxSyncCopyNodes + 1],
      );

      if (subtreeRows.length > maxSyncCopyNodes) {
        throw new VfsCopyLimitExceededError(maxSyncCopyNodes);
      }

      const childrenByParent = new Map<string, CopySourceRow[]>();
      for (const row of subtreeRows) {
        if (row.id === sourceNode.id) {
          continue;
        }
        const siblings = childrenByParent.get(row.parent_id as string) ?? [];
        siblings.push(row);
        childrenByParent.set(row.parent_id as string, siblings);
      }

      const newRoot = await nodeRepo.save(
        nodeRepo.create({ namespaceId, parentId: finalParentId, type: 'DIRECTORY', name: finalName }),
      );

      // 자식마다 save()를 순차 await하면 상한(최대 maxSyncCopyNodes)만큼 DB 왕복이
      // 발생하는 동안 lockParentChain이 잡은 namespace root lock을 계속 붙들고 있어
      // 같은 namespace의 다른 모든 mutation을 그만큼 오래 막는다. id를 미리 발급해
      // 트리 전체를 메모리에서 구성한 뒤 한 번에 bulk insert한다. id/created_at/
      // updated_at/version은 DB DEFAULT가 있으므로 자식 row에는 id만 직접 채운다.
      const blobIncrements = new Map<string, number>();
      const childRows: {
        id: string;
        namespaceId: string;
        parentId: string;
        type: VfsNodeType;
        name: string;
        blobId: string | null;
        size: string | null;
        mimeType: string | null;
      }[] = [];
      // BFS로 부모의 새 id가 먼저 정해진 뒤 자식의 parentId를 채운다. 실제 insert는
      // 한 트랜잭션 안에서 한 번에 일어나므로, 이 순서는 in-memory 구성 단계에서만
      // 필요하다.
      const queue: { oldParentId: string; newParentId: string }[] = [
        { oldParentId: sourceNode.id, newParentId: newRoot.id },
      ];

      while (queue.length > 0) {
        const { oldParentId, newParentId } = queue.shift() as { oldParentId: string; newParentId: string };

        for (const child of childrenByParent.get(oldParentId) ?? []) {
          const newId = randomUUID();

          if (child.type === 'FILE') {
            if (!child.blob_id) {
              throw new Error('FILE node에 blobId가 없음 — 데이터 일관성 위반');
            }
            blobIncrements.set(child.blob_id, (blobIncrements.get(child.blob_id) ?? 0) + 1);
          } else {
            queue.push({ oldParentId: child.id, newParentId: newId });
          }

          childRows.push({
            id: newId,
            namespaceId,
            parentId: newParentId,
            type: child.type,
            name: child.name,
            blobId: child.blob_id,
            size: child.size,
            mimeType: child.mime_type,
          });
        }
      }

      if (childRows.length > 0) {
        await nodeRepo.insert(nodeRepo.create(childRows));
      }

      // moveNode/removeNode와 동일한 이유로, 여러 독립적인 Blob에 대한 증가를
      // 고정된 순서(blobId 오름차순)로 수행해 잠재적 AB-BA 교착 소지를 없앤다.
      const sortedBlobIncrements = [...blobIncrements].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [blobId, count] of sortedBlobIncrements) {
        await blobRepo.increment({ id: blobId }, 'referenceCount', count);
      }

      return { node: toRecord(newRoot), finalPath: joinSegments(finalSegments) };
    });
  }

  async getBlobStorageInfo(
    namespaceId: string,
    blobId: string,
  ): Promise<{ storageKey: string; encryptionIv: Buffer | null } | null> {
    const blob = await this.blobRepo.findOneBy({ id: blobId, namespaceId });
    return blob ? { storageKey: blob.storageKey, encryptionIv: blob.encryptionIv } : null;
  }

  private async lockParentChain(
    manager: EntityManager,
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
  ): Promise<string> {
    const nodeRepo = manager.getRepository(VfsNodeEntity);
    let parentId = rootId;
    let parentType: VfsNodeType = 'DIRECTORY';

    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];

      if (parentType !== 'DIRECTORY') {
        throw new VfsNotDirectoryError(joinSegments(segments.slice(0, i)));
      }

      await this.applyRowLockIfSupported(
        manager.createQueryBuilder(VfsNodeEntity, 'n').where('n.id = :id', { id: parentId }),
      ).getOne();

      let child = await nodeRepo.findOneBy({ namespaceId, parentId, name });
      if (!child) {
        if (!parents) {
          throw new VfsNodeNotFoundError(joinSegments(segments.slice(0, i + 1)));
        }
        child = await nodeRepo.save(nodeRepo.create({ namespaceId, parentId, type: 'DIRECTORY', name }));
      }

      parentId = child.id;
      parentType = child.type;
    }

    if (parentType !== 'DIRECTORY') {
      throw new VfsNotDirectoryError(joinSegments(segments.slice(0, -1)));
    }

    await this.applyRowLockIfSupported(
      manager.createQueryBuilder(VfsNodeEntity, 'n').where('n.id = :id', { id: parentId }),
    ).getOne();

    return parentId;
  }

  // SQLite(better-sqlite3)는 명시적 row lock을 지원하지 않고 .setLock()
  // 호출 자체가 LockNotSupportedOnGivenDriverError로 던져진다. 단일 프로세스
  // 배포 전제에서 Node 이벤트 루프의 단일 스레드성 + better-sqlite3의 동기
  // 실행이 이미 같은 프로세스 내 쿼리 순서를 보장하므로, 프로세스 내부
  // 경쟁을 막기 위한 명시적 lock이 불필요하다(프로세스 간 경쟁은 배포
  // 모델상 발생하지 않는다고 전제).
  private applyRowLockIfSupported<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>): SelectQueryBuilder<T> {
    if (this.dataSource.options.type === 'better-sqlite3') {
      return qb;
    }
    return qb.setLock('pessimistic_write');
  }

  private async lockTargetNode(
    manager: EntityManager,
    namespaceId: string,
    parentId: string,
    name: string,
  ): Promise<VfsNodeEntity | null> {
    return this.applyRowLockIfSupported(
      manager
        .createQueryBuilder(VfsNodeEntity, 'n')
        .where('n.namespace_id = :namespaceId', { namespaceId })
        .andWhere('n.parent_id = :parentId', { parentId })
        .andWhere('n.name = :name', { name }),
    ).getOne();
  }
}
