import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { classifyPersistenceFailure } from './persistence-failure.js';
import { isSqliteDataSource } from '../common/db-driver.js';
import { encodeRevision, MAX_VFS_VERSION } from '../vfs/revision.js';
import {
  VfsNodeNotFoundError,
  VfsNamespaceNotFoundError,
  VfsNotDirectoryError,
  VfsRevisionExhaustedError,
  VfsQuotaExceededError,
  VfsFolderFileLimitExceededError,
  VfsNamespaceNodeLimitExceededError,
} from '../vfs/vfs.errors.js';
import { DEFAULT_MAX_LIVE_NODES, resolveCountLimits } from '../common/resource-limit.js';
import {
  resolveGlobalTotalLogicalByteLimits,
  resolveNamespaceQuota,
  resolveEnforcedLogicalBytes,
} from '../vfs/namespace-quota.js';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { withExactNamespaceBigints } from './namespace-bigint-read.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import type { VfsNodeType } from './entities/vfs-node.entity.js';
import type { MutationTx, AffectedRevision, WithMutationOptions } from './vfs-node.repository.types.js';
import { chunked, joinSegments, NODE_BULK_CHUNK_SIZE } from './vfs-node.repository.helpers.js';
import { VfsChangeFeedStateEntity } from './entities/vfs-change-feed-state.entity.js';
import {
  appendChangeFeedEvents,
  captureChangeFeedNodes,
  readChangeFeedEvents,
  readChangeFeedState,
  trackChangeFeedBefore,
} from './vfs-change-feed-journal.js';
import type { ChangeFeedState } from './vfs-change-feed-journal.js';

export class VfsNodeRepositoryCore {
  protected readonly defaultMaxTotalLogicalBytes: bigint;
  protected readonly maxTotalLogicalBytes: bigint;
  protected readonly defaultMaxFilesPerFolder: bigint;
  protected readonly maxFilesPerFolder: bigint;
  protected readonly defaultMaxLiveNodes: bigint;
  protected readonly maxLiveNodes: bigint;
  protected readonly namespaceRepo: Repository<NamespaceEntity>;
  protected readonly nodeRepo: Repository<VfsNodeEntity>;
  protected readonly blobRepo: Repository<BlobEntity>;
  protected readonly dataSource: DataSource;
  protected readonly blobRepository: BlobRepository;

  constructor(
    namespaceRepo: Repository<NamespaceEntity>,
    nodeRepo: Repository<VfsNodeEntity>,
    blobRepo: Repository<BlobEntity>,
    dataSource: DataSource,
    blobRepository: BlobRepository,
    config: ConfigService,
  ) {
    this.namespaceRepo = namespaceRepo;
    this.nodeRepo = nodeRepo;
    this.blobRepo = blobRepo;
    this.dataSource = dataSource;
    this.blobRepository = blobRepository;
    const totalLogicalByteLimits = resolveGlobalTotalLogicalByteLimits(
      config.get<string>('STORIX_DEFAULT_TOTAL_LOGICAL_BYTES'),
      config.get<string>('STORIX_MAX_TOTAL_LOGICAL_BYTES'),
    );
    this.defaultMaxTotalLogicalBytes = totalLogicalByteLimits.defaultBytes;
    this.maxTotalLogicalBytes = totalLogicalByteLimits.ceilingBytes;
    const folderLimits = resolveCountLimits(
      config.get<string>('STORIX_DEFAULT_MAX_FILES_PER_FOLDER'),
      config.get<string>('STORIX_MAX_FILES_PER_FOLDER'),
    );
    this.defaultMaxFilesPerFolder = BigInt(folderLimits.defaultValue);
    this.maxFilesPerFolder = BigInt(folderLimits.ceilingValue);
    const liveNodeLimits = resolveCountLimits(
      config.get<string>('STORIX_DEFAULT_MAX_LIVE_NODES'),
      config.get<string>('STORIX_MAX_LIVE_NODES'),
      DEFAULT_MAX_LIVE_NODES,
    );
    this.defaultMaxLiveNodes = BigInt(liveNodeLimits.defaultValue);
    this.maxLiveNodes = BigInt(liveNodeLimits.ceilingValue);
  }

  protected get isSqlite(): boolean {
    return isSqliteDataSource(this.dataSource.options);
  }

  async withMutation<T>(
    namespaceId: string,
    rootId: string,
    work: (tx: MutationTx) => Promise<T>,
    afterBump?: (
      tx: MutationTx,
      result: { value: T; affectedRevisions: AffectedRevision[] },
    ) => Promise<void>,
    options: WithMutationOptions = {},
  ): Promise<{ value: T; affectedRevisions: AffectedRevision[] }> {
    let callbackError: unknown;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const namespaceRoot = await this.lockNamespaceRoot(manager, namespaceId, options.allowInactive);
        if (!options.allowInactive) await this.assertNamespaceActive(manager, namespaceId);
        if (namespaceRoot.id !== rootId) {
          const startingNode = await manager
            .getRepository(VfsNodeEntity)
            .findOneBy({ id: rootId, namespaceId });
          if (!startingNode || startingNode.type !== 'DIRECTORY') throw new VfsNodeNotFoundError('/');
        }
        const feedState = await readChangeFeedState(manager, namespaceId, this.isSqlite);
        const before = feedState?.hasCheckpoint ? new Map() : null;
        const tx: MutationTx = {
          manager,
          namespaceId,
          rootId,
          changed: new Map(),
          feedBefore: before,
          liveFileByteDelta: 0n,
          logicalByteDelta: 0n,
          liveNodeDelta: 0n,
          ancestorChainMarked: new Set(),
          folderFileDeltas: new Map(),
          trashByteDelta: 0n,
          snapshotByteDelta: 0n,
          defaultMaxTotalLogicalBytes: this.defaultMaxTotalLogicalBytes,
          maxTotalLogicalBytes: this.maxTotalLogicalBytes,
        };
        let value: T;
        try {
          value = await work(tx);
        } catch (error) {
          callbackError = error;
          throw error;
        }
        await this.applyNodeCounters(tx);
        await this.applyLogicalByteQuota(tx);
        const affectedRevisions = await this.bumpAndReadChangedNodes(tx);
        if (afterBump) {
          try {
            await afterBump(tx, { value, affectedRevisions });
          } catch (error) {
            callbackError = error;
            throw error;
          }
        }
        if (before)
          await appendChangeFeedEvents(manager, namespaceId, before, [...tx.changed.keys()], this.isSqlite);
        return { value, affectedRevisions };
      });
    } catch (error) {
      // work/afterBump는 클라이언트 업로드 stream을 소비할 수 있다. callback의 원시 transport 코드는
      // DB에서 났다는 근거가 없으므로 driverError가 없으면 분류하지 않는다.
      if (error === callbackError && !(error as { driverError?: unknown })?.driverError) throw error;
      throw classifyPersistenceFailure(error) ?? error;
    }
  }

  // cursor 없는 요청은 mutation과 같은 namespace 직렬화 지점에서 발급한다.
  async createChangeFeedCheckpoint(namespaceId: string, rootId: string): Promise<string> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const namespaceRoot = await this.lockNamespaceRoot(manager, namespaceId);
        await this.assertNamespaceActive(manager, namespaceId);
        if (namespaceRoot.id !== rootId) throw new VfsNodeNotFoundError('/');
        const states = manager.getRepository(VfsChangeFeedStateEntity);
        const state = await readChangeFeedState(manager, namespaceId, this.isSqlite);
        if (!state) {
          await states.insert({
            namespaceId,
            lastSequence: '0',
            prunedThrough: '0',
            hasCheckpoint: true,
            signingSecret: randomBytes(32).toString('hex'),
          });
        } else if (!state.hasCheckpoint) {
          await states.update({ namespaceId }, { hasCheckpoint: true });
        }
        return state?.lastSequence ?? '0';
      });
    } catch (error) {
      throw classifyPersistenceFailure(error) ?? error;
    }
  }

  async getChangeFeedState(namespaceId: string) {
    return readChangeFeedState(this.dataSource.manager, namespaceId, this.isSqlite);
  }

  async listChangeFeedEvents(namespaceId: string, afterSequence: string, limit: number) {
    return readChangeFeedEvents(this.dataSource.manager, namespaceId, afterSequence, limit, this.isSqlite);
  }

  // PostgreSQL READ COMMITTED에서는 state와 events가 다른 snapshot일 수 있다.
  // REPEATABLE READ에서 첫 state 조회부터 event 조회까지 한 snapshot을 유지한다.
  // SQLite에서는 transaction이 단일 프로세스 query gate를 끝까지 점유한다.
  async readChangeFeedPage(
    namespaceId: string,
    limit: number,
    resolveSequence: (state: ChangeFeedState | null) => string | Promise<string>,
  ) {
    const read = async (manager: EntityManager) => {
      const state = await readChangeFeedState(manager, namespaceId, this.isSqlite);
      const sequence = await resolveSequence(state);
      if (!state) throw new Error('Change feed state missing after cursor validation');
      const events = await readChangeFeedEvents(manager, namespaceId, sequence, limit, this.isSqlite);
      return { state, events };
    };
    try {
      return this.isSqlite
        ? await this.dataSource.transaction(read)
        : await this.dataSource.transaction('REPEATABLE READ', read);
    } catch (error) {
      throw classifyPersistenceFailure(error) ?? error;
    }
  }

  /** root 잠금 뒤 namespace 상태를 다시 읽어 삭제 접수와 반영 순서를 고정한다. */
  protected async assertNamespaceActive(manager: EntityManager, namespaceId: string): Promise<void> {
    const namespace = await manager.getRepository(NamespaceEntity).findOne({
      select: { id: true, status: true },
      where: { id: namespaceId },
    });
    if (namespace?.status !== 'ACTIVE') throw new VfsNamespaceNotFoundError(namespaceId);
  }

  /** root를 잠근다. DELETED로 root가 사라진 경우는 root 부재가 아니라 비활성 namespace로 구분해 던진다. */
  private async lockNamespaceRoot(
    manager: EntityManager,
    namespaceId: string,
    allowInactive = false,
  ): Promise<VfsNodeEntity> {
    const root = await this.applyRowLockIfSupported(
      manager
        .createQueryBuilder(VfsNodeEntity, 'n')
        .where('n.namespace_id = :namespaceId AND n.parent_id IS NULL', { namespaceId }),
    ).getOne();
    if (!root || root.type !== 'DIRECTORY') {
      if (!allowInactive) await this.assertNamespaceActive(manager, namespaceId);
      throw new VfsNodeNotFoundError('/');
    }
    return root;
  }

  protected recordLiveByteDelta(tx: MutationTx, delta: bigint): void {
    tx.liveFileByteDelta += delta;
    tx.logicalByteDelta += delta;
  }

  protected recordFolderFileDelta(tx: MutationTx, parentId: string, delta: bigint): void {
    if (delta === 0n) return;
    tx.folderFileDeltas.set(parentId, (tx.folderFileDeltas.get(parentId) ?? 0n) + delta);
  }

  protected recordLiveNodeDelta(tx: MutationTx, delta: bigint): void {
    tx.liveNodeDelta += delta;
  }

  private async applyNodeCounters(tx: MutationTx): Promise<void> {
    const deltas = [...tx.folderFileDeltas].filter(([, delta]) => delta !== 0n);
    if (deltas.length === 0 && tx.liveNodeDelta === 0n) return;
    const namespace = (
      await withExactNamespaceBigints(tx.manager, [
        await tx.manager.getRepository(NamespaceEntity).findOneByOrFail({ id: tx.namespaceId }),
      ])
    )[0];
    if (tx.liveNodeDelta !== 0n) {
      const nextLiveNodes = BigInt(String(namespace.liveNodeCount)) + tx.liveNodeDelta;
      if (nextLiveNodes < 0n) throw new Error('namespace live node counter became negative');
      const nodeLimit =
        namespace.maxLiveNodes === null
          ? this.defaultMaxLiveNodes
          : BigInt(String(namespace.maxLiveNodes)) < this.maxLiveNodes
            ? BigInt(String(namespace.maxLiveNodes))
            : this.maxLiveNodes;
      if (tx.liveNodeDelta > 0n && nextLiveNodes > nodeLimit)
        throw new VfsNamespaceNodeLimitExceededError(nodeLimit.toString(), nextLiveNodes.toString());
      await tx.manager
        .getRepository(NamespaceEntity)
        .createQueryBuilder()
        .update(NamespaceEntity)
        .set({ liveNodeCount: nextLiveNodes.toString(), updatedAt: () => 'updated_at' })
        .where('id = :namespaceId', { namespaceId: tx.namespaceId })
        .execute();
    }
    const limit =
      namespace.maxFilesPerFolder === null
        ? this.defaultMaxFilesPerFolder
        : BigInt(String(namespace.maxFilesPerFolder)) < this.maxFilesPerFolder
          ? BigInt(String(namespace.maxFilesPerFolder))
          : this.maxFilesPerFolder;
    const nodeRepo = tx.manager.getRepository(VfsNodeEntity);
    for (const [parentId, delta] of deltas) {
      const parent = await nodeRepo.findOneBy({
        id: parentId,
        namespaceId: tx.namespaceId,
        type: 'DIRECTORY',
      });
      if (!parent && delta < 0n) continue;
      if (!parent) throw new Error('folder child FILE counter parent is missing');
      const next = BigInt(String(parent.childFileCount ?? '0')) + delta;
      if (next < 0n) throw new Error('folder child FILE counter became negative');
      if (delta > 0n && next > limit)
        throw new VfsFolderFileLimitExceededError(limit.toString(), next.toString());
      await nodeRepo
        .createQueryBuilder()
        .update(VfsNodeEntity)
        .set({
          childFileCount: next.toString(),
          version: () => 'version',
          updatedAt: () => 'updated_at',
        })
        .where('id = :parentId', { parentId })
        .execute();
    }
  }

  private async applyLogicalByteQuota(tx: MutationTx): Promise<void> {
    if (tx.liveFileByteDelta === 0n && tx.trashByteDelta === 0n && tx.snapshotByteDelta === 0n) return;

    const namespaces = tx.manager.getRepository(NamespaceEntity);
    const namespace = (
      await withExactNamespaceBigints(tx.manager, [await namespaces.findOneByOrFail({ id: tx.namespaceId })])
    )[0];
    const liveBytes = BigInt(namespace.liveFileByteCount) + tx.liveFileByteDelta;
    const retainedBytes = BigInt(namespace.retainedSnapshotByteCount);
    const retainedTrashBytes = BigInt(namespace.retainedTrashByteCount);
    if (liveBytes < 0n || liveBytes > 9223372036854775807n) {
      throw new Error('namespace live file byte counter out of int64 range');
    }
    const enforcedBytes = resolveEnforcedLogicalBytes(
      liveBytes.toString(),
      retainedTrashBytes.toString(),
      retainedBytes.toString(),
      namespace.excludeTrashFromQuota ?? false,
      namespace.excludeSnapshotsFromQuota ?? false,
    );
    const enforcedDelta =
      tx.liveFileByteDelta +
      ((namespace.excludeTrashFromQuota ?? false) ? 0n : tx.trashByteDelta) +
      ((namespace.excludeSnapshotsFromQuota ?? false) ? 0n : tx.snapshotByteDelta);

    if (enforcedDelta > 0n) {
      const limit = resolveNamespaceQuota(
        namespace.maxTotalLogicalBytes === null ? null : String(namespace.maxTotalLogicalBytes),
        this.maxTotalLogicalBytes,
        this.defaultMaxTotalLogicalBytes,
      );
      if (enforcedBytes > limit) throw new VfsQuotaExceededError(limit.toString(), enforcedBytes.toString());
    }

    if (tx.liveFileByteDelta !== 0n) {
      await namespaces.update({ id: tx.namespaceId }, { liveFileByteCount: liveBytes.toString() });
    }
  }

  protected markChanged(tx: MutationTx, id: string, increment: boolean): void {
    const previous = tx.changed.get(id);
    if (!previous) {
      tx.changed.set(id, { path: '', increment });
    }
  }

  protected async markAncestorChain(tx: MutationTx, id: string): Promise<void> {
    const nodeRepo = tx.manager.getRepository(VfsNodeEntity);
    const walked: string[] = [];
    let currentId: string | null = id;
    // 이미 표시한 노드를 만나면 그 위쪽 조상도 표시된 상태다. mkdir -p는 새 디렉터리마다 이 함수를 불러
    // 매번 root까지 걸으면 깊이에 이차가 된다(TRP-008).
    while (currentId && !tx.ancestorChainMarked.has(currentId)) {
      const current: VfsNodeEntity | null = await nodeRepo.findOneBy({
        id: currentId,
        namespaceId: tx.namespaceId,
      });
      if (!current) throw new VfsNodeNotFoundError('/');
      this.markChanged(tx, currentId, true);
      walked.push(currentId);
      currentId = current.parentId;
    }
    // 조상 전체를 한 번에 읽어야 경로를 한 번만 해석한다. 조상마다 부르면 깊이에 이차다.
    await trackChangeFeedBefore(tx, walked);
    // 중간에 오류가 나면 트랜잭션이 롤백되므로 걷기를 마친 뒤에만 기록한다.
    for (const walkedId of walked) tx.ancestorChainMarked.add(walkedId);
  }

  /**
   * 변경된 노드의 version을 올리고 응답에 실을 최종 revision을 읽는다.
   * DB 왕복은 노드 수를 청크 크기로 나눈 만큼과 변경 집합 밖 조상 수만큼만 쓴다.
   * 노드마다 노드·부모 체인을 개별 조회하면 평평한 12,000개 cp가 쿼리 약 3만 6천 개,
   * 깊이 1,500 체인 mv·cp가 약 113만 개(깊이의 제곱)가 된다.
   */
  protected async bumpAndReadChangedNodes(tx: MutationTx): Promise<AffectedRevision[]> {
    const nodeRepo = tx.manager.getRepository(VfsNodeEntity);
    const incrementIds = [...tx.changed].filter(([, change]) => change.increment).map(([id]) => id);
    for (const ids of chunked(incrementIds, NODE_BULK_CHUNK_SIZE)) {
      const result = await nodeRepo
        .createQueryBuilder()
        .update(VfsNodeEntity)
        .set({ version: () => 'version + 1', updatedAt: () => 'CURRENT_TIMESTAMP' })
        .where('id IN (:...ids) AND version < :maxVersion', { ids, maxVersion: MAX_VFS_VERSION })
        .execute();
      // 청크 안에 상한에 닿은 노드가 하나라도 있으면 affected가 모자란다. 트랜잭션 전체가 롤백된다.
      if (result.affected !== ids.length) {
        throw new VfsRevisionExhaustedError();
      }
    }

    // version 증가 뒤의 최종 상태를 읽는다. 변경 집합에 없는 조상만 추가로 조회한다.
    const states = await captureChangeFeedNodes(tx.manager, tx.namespaceId, [...tx.changed.keys()]);
    const result: AffectedRevision[] = [];
    for (const { node, path } of states.values()) {
      result.push({ path, revision: encodeRevision(node) });
    }
    return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  protected async resolvePathInManager(
    manager: EntityManager,
    namespaceId: string,
    rootId: string,
    segments: string[],
  ): Promise<VfsNodeEntity | null> {
    const nodeRepo = manager.getRepository(VfsNodeEntity);
    let node = await nodeRepo.findOneBy({ id: rootId, namespaceId });
    for (const segment of segments) {
      if (!node || node.type !== 'DIRECTORY') return null;
      node = await nodeRepo.findOneBy({ namespaceId, parentId: node.id, name: segment });
    }
    return node;
  }

  protected async lockParentChain(
    manager: EntityManager,
    namespaceId: string,
    rootId: string,
    segments: string[],
    parents: boolean,
    tx?: MutationTx,
    markAncestors = true,
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
      if (tx) await trackChangeFeedBefore(tx, [parentId]);

      let child = await nodeRepo.findOneBy({ namespaceId, parentId, name });
      if (!child) {
        if (!parents) {
          throw new VfsNodeNotFoundError(joinSegments(segments.slice(0, i + 1)));
        }
        child = await nodeRepo.save(nodeRepo.create({ namespaceId, parentId, type: 'DIRECTORY', name }));
        if (tx) this.recordLiveNodeDelta(tx, 1n);
        if (tx) {
          await this.markAncestorChain(tx, parentId);
          this.markChanged(tx, child.id, false);
        }
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
    if (tx) await trackChangeFeedBefore(tx, [parentId]);

    if (tx && markAncestors) {
      await this.markAncestorChain(tx, parentId);
    }

    return parentId;
  }

  // SQLite(better-sqlite3)는 명시적 row lock을 지원하지 않고 .setLock()
  // 호출 자체가 LockNotSupportedOnGivenDriverError로 던져진다. 단일 프로세스
  // 배포 전제에서 Node 이벤트 루프의 단일 스레드성 + better-sqlite3의 동기
  // 실행이 이미 같은 프로세스 내 쿼리 순서를 보장하므로, 프로세스 내부
  // 경쟁을 막기 위한 명시적 lock이 불필요하다(프로세스 간 경쟁은 배포
  // 모델상 발생하지 않는다고 전제).
  protected applyRowLockIfSupported<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
  ): SelectQueryBuilder<T> {
    if (this.isSqlite) {
      return qb;
    }
    return qb.setLock('pessimistic_write');
  }

  protected async lockTargetNode(
    manager: EntityManager,
    namespaceId: string,
    parentId: string,
    name: string,
    tx?: MutationTx,
  ): Promise<VfsNodeEntity | null> {
    const node = await this.applyRowLockIfSupported(
      manager
        .createQueryBuilder(VfsNodeEntity, 'n')
        .where('n.namespace_id = :namespaceId', { namespaceId })
        .andWhere('n.parent_id = :parentId', { parentId })
        .andWhere('n.name = :name', { name }),
    ).getOne();
    if (node && tx) await trackChangeFeedBefore(tx, [node.id]);
    return node;
  }
}
