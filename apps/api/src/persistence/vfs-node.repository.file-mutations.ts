import { EntityManager } from 'typeorm';
import { classifyPersistenceOperation } from './persistence-failure.js';
import { MAX_VFS_VERSION } from '../vfs/revision.js';
import { assertPathSegments } from '../vfs/path-resolver.js';
import { DialectPlaceholders } from './dialect-placeholders.js';
import {
  VfsAlreadyExistsError,
  VfsDirectoryNotEmptyError,
  VfsInvalidOperationError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsRevisionExhaustedError,
  VfsVersionConflictError,
} from '../vfs/vfs.errors.js';
import { BlobEntity } from './entities/blob.entity.js';
import { VfsNodeEntity, VfsNodeType } from './entities/vfs-node.entity.js';
import type {
  VfsNodeRecord,
  BlobData,
  PutFileOutcome,
  MutationTx,
  NamedDescendant,
} from './vfs-node.repository.types.js';
import {
  assertSubtreeDestinationPaths,
  toRecord,
  joinSegments,
  compareSegments,
} from './vfs-node.repository.helpers.js';
import { VfsNodeRepositorySnapshots } from './vfs-node.repository.snapshots.js';
import { trackChangeFeedBefore } from './vfs-change-feed-journal.js';

export class VfsNodeRepositoryFileMutations extends VfsNodeRepositorySnapshots {
  @classifyPersistenceOperation
  async ensureDirectory(
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
    tx?: MutationTx,
  ): Promise<{ node: VfsNodeRecord; created: boolean }> {
    if (!tx) {
      return (
        await this.withMutation(namespaceId, rootId, (inner) =>
          this.ensureDirectory(namespaceId, rootId, segments, parents, inner),
        )
      ).value;
    }
    const manager = tx.manager;
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
        await this.markAncestorChain(tx, parentId);
        this.markChanged(tx, child.id, false);
        if (isLast) {
          created = true;
        }
      }

      current = child;
      parentId = child.id;
      parentType = child.type;
    }

    return { node: toRecord(current as VfsNodeEntity), created };
  }

  @classifyPersistenceOperation
  async touchFile(
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
    emptyBlob: BlobData,
    tx?: MutationTx,
  ): Promise<PutFileOutcome> {
    if (!tx) {
      return (
        await this.withMutation(namespaceId, rootId, (inner) =>
          this.touchFile(namespaceId, rootId, segments, parents, emptyBlob, inner),
        )
      ).value;
    }
    const manager = tx.manager;
    const nodeRepo = manager.getRepository(VfsNodeEntity);
    const blobRepo = manager.getRepository(BlobEntity);
    const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, parents, tx);
    const name = segments[segments.length - 1];

    const existing = await this.lockTargetNode(manager, namespaceId, parentId, name, tx);

    if (existing) {
      if (existing.type === 'DIRECTORY') {
        throw new VfsIsDirectoryError(joinSegments(segments));
      }
      if (existing.version >= MAX_VFS_VERSION) {
        throw new VfsRevisionExhaustedError();
      }
      // content는 그대로 두고 updatedAt만 갱신해 diff를 발생시킨다.
      // TypeORM은 변경된 column이 없으면 UPDATE 자체를 생략해 @VersionColumn도
      // 증가하지 않으므로, save()만 호출해서는 touch의 "version만 올린다" 요구를 만족할 수 없다.
      existing.updatedAt = new Date();
      const touched = await nodeRepo.save(existing);
      this.markChanged(tx, touched.id, false);
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
    this.markChanged(tx, created.id, false);
    this.recordLiveByteDelta(tx, BigInt(emptyBlob.size));

    return { kind: 'created', node: toRecord(created) };
  }

  @classifyPersistenceOperation
  async putFileContent(
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
    newBlob: BlobData,
    ifMatchVersion: number | null,
    force: boolean,
    tx?: MutationTx,
  ): Promise<PutFileOutcome> {
    if (!tx) {
      return (
        await this.withMutation(namespaceId, rootId, (inner) =>
          this.putFileContent(namespaceId, rootId, segments, parents, newBlob, ifMatchVersion, force, inner),
        )
      ).value;
    }
    const manager = tx.manager;
    const nodeRepo = manager.getRepository(VfsNodeEntity);
    const blobRepo = manager.getRepository(BlobEntity);
    const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, parents, tx);
    const name = segments[segments.length - 1];

    const existing = await this.lockTargetNode(manager, namespaceId, parentId, name, tx);

    if (existing) {
      if (existing.type === 'DIRECTORY') {
        throw new VfsIsDirectoryError(joinSegments(segments));
      }
      if (existing.version >= MAX_VFS_VERSION) {
        throw new VfsRevisionExhaustedError();
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
      if (existing.size === null) throw new Error('FILE node에 size가 없음 — 데이터 일관성 위반');
      const previousSize = BigInt(existing.size);

      existing.blobId = createdBlob.id;
      existing.size = newBlob.size;
      existing.mimeType = newBlob.mimeType;
      const saved = await nodeRepo.save(existing);
      this.markChanged(tx, saved.id, false);
      this.recordLiveByteDelta(tx, BigInt(newBlob.size) - previousSize);

      await this.blobRepository.decrementReferenceCount(manager, previousBlobId, 1);

      return { kind: 'replaced', node: toRecord(saved) };
    }

    const createdBlob = await blobRepo.save(blobRepo.create({ namespaceId, ...newBlob, referenceCount: 1 }));
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
    this.markChanged(tx, created.id, false);
    this.recordLiveByteDelta(tx, BigInt(newBlob.size));

    return { kind: 'created', node: toRecord(created) };
  }

  protected async resolveDestinationPlacement(
    manager: EntityManager,
    namespaceId: string,
    rootId: string,
    sourceSegments: string[],
    destinationSegments: string[],
    destinationParents: boolean,
    tx?: MutationTx,
    markSourceAncestors = true,
    destinationResolution?: 'exact',
  ): Promise<{
    sourceNode: VfsNodeEntity;
    finalParentId: string;
    finalName: string;
    finalSegments: string[];
  }> {
    const resolveSource = async (): Promise<VfsNodeEntity> => {
      const parentId = await this.lockParentChain(
        manager,
        namespaceId,
        rootId,
        sourceSegments,
        false,
        tx,
        markSourceAncestors,
      );
      const name = sourceSegments[sourceSegments.length - 1];
      const node = await this.lockTargetNode(manager, namespaceId, parentId, name, tx);
      if (!node) {
        throw new VfsNodeNotFoundError(joinSegments(sourceSegments));
      }
      return node;
    };

    const resolveDestinationParent = () =>
      this.lockParentChain(manager, namespaceId, rootId, destinationSegments, destinationParents, tx);

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
      ? await this.lockTargetNode(manager, namespaceId, destinationParentId, destinationName, tx)
      : null;

    // exact는 `/`를 항상 존재하는 목적지로 본다. 기존 FILE·DIRECTORY 충돌은 아래 non-nest 분기가
    // subtree 검사(409) 뒤에 판정해 기존 placement와 같은 오류 우선순위를 유지한다.
    if (destinationResolution === 'exact' && destinationSegments.length === 0) {
      throw new VfsAlreadyExistsError(joinSegments(destinationSegments));
    }

    const nestUnderDirectory =
      destinationResolution !== 'exact' &&
      (destinationSegments.length === 0 || destinationTarget?.type === 'DIRECTORY');
    const sourceBasename = sourceSegments[sourceSegments.length - 1];

    const finalParentId = nestUnderDirectory
      ? destinationSegments.length === 0
        ? destinationParentId
        : (destinationTarget as VfsNodeEntity).id
      : destinationParentId;
    const finalName = nestUnderDirectory ? sourceBasename : (destinationName as string);
    const finalSegments = nestUnderDirectory ? [...destinationSegments, sourceBasename] : destinationSegments;
    assertPathSegments(finalSegments);

    if (tx && nestUnderDirectory && destinationTarget) {
      this.markChanged(tx, destinationTarget.id, true);
    }

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
      const collision = await this.lockTargetNode(manager, namespaceId, finalParentId, finalName, tx);
      if (collision) {
        throw new VfsAlreadyExistsError(joinSegments(finalSegments));
      }
    } else if (destinationTarget) {
      throw new VfsAlreadyExistsError(joinSegments(destinationSegments));
    }

    return { sourceNode, finalParentId, finalName, finalSegments };
  }

  @classifyPersistenceOperation
  async moveNode(
    namespaceId: string,
    rootId: string,
    sourceSegments: string[],
    destinationSegments: string[],
    destinationParents: boolean,
    tx?: MutationTx,
    destinationResolution?: 'exact',
  ): Promise<{ node: VfsNodeRecord; finalPath: string }> {
    if (!tx) {
      return (
        await this.withMutation(namespaceId, rootId, (inner) =>
          this.moveNode(
            namespaceId,
            rootId,
            sourceSegments,
            destinationSegments,
            destinationParents,
            inner,
            destinationResolution,
          ),
        )
      ).value;
    }
    const manager = tx.manager;
    const { sourceNode, finalParentId, finalName, finalSegments } = await this.resolveDestinationPlacement(
      manager,
      namespaceId,
      rootId,
      sourceSegments,
      destinationSegments,
      destinationParents,
      tx,
      true,
      destinationResolution,
    );

    if (sourceNode.version >= MAX_VFS_VERSION) {
      throw new VfsRevisionExhaustedError();
    }

    const ph = new DialectPlaceholders(this.isSqlite);
    const descendants: NamedDescendant[] = await manager.query(
      `WITH RECURSIVE subtree AS (
           SELECT id, parent_id, name FROM vfs_node WHERE parent_id = ${ph.bind(sourceNode.id)}
           UNION ALL SELECT n.id, n.parent_id, n.name FROM vfs_node n JOIN subtree s ON n.parent_id = s.id
         ) SELECT id, parent_id, name FROM subtree`,
      ph.params,
    );
    await trackChangeFeedBefore(tx, descendants.map((descendant) => descendant.id));
    assertSubtreeDestinationPaths(sourceNode.id, finalSegments, descendants);

    sourceNode.parentId = finalParentId;
    sourceNode.name = finalName;
    const saved = await manager.getRepository(VfsNodeEntity).save(sourceNode);
    this.markChanged(tx, saved.id, false);
    for (const descendant of descendants) this.markChanged(tx, descendant.id, true);

    return { node: toRecord(saved), finalPath: joinSegments(finalSegments) };
  }

  @classifyPersistenceOperation
  async removeEmptyDirectory(
    namespaceId: string,
    rootId: string,
    segments: string[],
    tx?: MutationTx,
  ): Promise<void> {
    if (!tx) {
      await this.withMutation(namespaceId, rootId, (inner) =>
        this.removeEmptyDirectory(namespaceId, rootId, segments, inner),
      );
      return;
    }
    const manager = tx.manager;
    const parentId = await this.lockParentChain(manager, namespaceId, rootId, segments, false, tx);
    const name = segments[segments.length - 1];
    const target = await this.lockTargetNode(manager, namespaceId, parentId, name, tx);

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
  }

  @classifyPersistenceOperation
  async getBlobStorageInfo(
    namespaceId: string,
    blobId: string,
  ): Promise<{ storageKey: string; encryptionIv: Buffer | null } | null> {
    const blob = await this.blobRepo.findOneBy({ id: blobId, namespaceId });
    return blob ? { storageKey: blob.storageKey, encryptionIv: blob.encryptionIv } : null;
  }
}
