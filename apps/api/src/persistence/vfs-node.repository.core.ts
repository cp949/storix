import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { classifyPersistenceFailure } from './persistence-failure.js';
import { isSqliteDataSource } from '../common/db-driver.js';
import { encodeRevision, MAX_VFS_VERSION } from '../vfs/revision.js';
import {
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsRevisionExhaustedError,
  VfsQuotaExceededError,
} from '../vfs/vfs.errors.js';
import {
  resolveGlobalTotalLogicalByteLimit,
  resolveNamespaceQuota,
  resolveTotalLogicalBytes,
} from '../vfs/namespace-quota.js';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { withExactNamespaceBigints } from './namespace-bigint-read.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import type { VfsNodeType } from './entities/vfs-node.entity.js';
import type { MutationTx, AffectedRevision } from './vfs-node.repository.types.js';
import { joinSegments } from './vfs-node.repository.helpers.js';
import { VfsChangeFeedStateEntity } from './entities/vfs-change-feed-state.entity.js';
import {
  appendChangeFeedEvents,
  readChangeFeedEvents,
  readChangeFeedState,
  trackChangeFeedBefore,
} from './vfs-change-feed-journal.js';
import type { ChangeFeedState } from './vfs-change-feed-journal.js';

export class VfsNodeRepositoryCore {
  protected readonly maxTotalLogicalBytes: bigint;
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
    this.maxTotalLogicalBytes = resolveGlobalTotalLogicalByteLimit(
      config.get<string>('STORIX_MAX_TOTAL_LOGICAL_BYTES'),
    );
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
  ): Promise<{ value: T; affectedRevisions: AffectedRevision[] }> {
    let callbackError: unknown;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const namespaceRoot = await this.lockNamespaceRoot(manager, namespaceId);
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
        };
        let value: T;
        try {
          value = await work(tx);
        } catch (error) {
          callbackError = error;
          throw error;
        }
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

  // DELTA-03의 cursor 없는 요청은 mutation과 같은 namespace 직렬화 지점에서 발급한다.
  async createChangeFeedCheckpoint(namespaceId: string, rootId: string): Promise<string> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const namespaceRoot = await this.lockNamespaceRoot(manager, namespaceId);
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

  private async lockNamespaceRoot(manager: EntityManager, namespaceId: string): Promise<VfsNodeEntity> {
    const root = await this.applyRowLockIfSupported(
      manager
        .createQueryBuilder(VfsNodeEntity, 'n')
        .where('n.namespace_id = :namespaceId AND n.parent_id IS NULL', { namespaceId }),
    ).getOne();
    if (!root || root.type !== 'DIRECTORY') throw new VfsNodeNotFoundError('/');
    return root;
  }

  protected recordLiveByteDelta(tx: MutationTx, delta: bigint): void {
    tx.liveFileByteDelta += delta;
    tx.logicalByteDelta += delta;
  }

  private async applyLogicalByteQuota(tx: MutationTx): Promise<void> {
    if (tx.logicalByteDelta <= 0n && tx.liveFileByteDelta === 0n) return;

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
    const totalBytes = resolveTotalLogicalBytes(
      liveBytes.toString(),
      retainedBytes.toString(),
      retainedTrashBytes.toString(),
    );

    if (tx.logicalByteDelta > 0n) {
      const limit = resolveNamespaceQuota(
        namespace.maxTotalLogicalBytes === null ? null : String(namespace.maxTotalLogicalBytes),
        this.maxTotalLogicalBytes,
      );
      if (totalBytes > limit) throw new VfsQuotaExceededError(limit.toString(), totalBytes.toString());
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
    let currentId: string | null = id;
    while (currentId) {
      const current: VfsNodeEntity | null = await nodeRepo.findOneBy({
        id: currentId,
        namespaceId: tx.namespaceId,
      });
      if (!current) throw new VfsNodeNotFoundError('/');
      await trackChangeFeedBefore(tx, [current.id]);
      this.markChanged(tx, currentId, true);
      currentId = current.parentId;
    }
  }

  protected async bumpAndReadChangedNodes(tx: MutationTx): Promise<AffectedRevision[]> {
    const nodeRepo = tx.manager.getRepository(VfsNodeEntity);
    for (const [id, change] of tx.changed) {
      if (!change.increment) continue;
      const result = await nodeRepo
        .createQueryBuilder()
        .update(VfsNodeEntity)
        .set({ version: () => 'version + 1', updatedAt: () => 'CURRENT_TIMESTAMP' })
        .where('id = :id AND version < :maxVersion', { id, maxVersion: MAX_VFS_VERSION })
        .execute();
      if (result.affected !== 1) {
        throw new VfsRevisionExhaustedError();
      }
    }

    const result: AffectedRevision[] = [];
    for (const id of tx.changed.keys()) {
      const node = await nodeRepo.findOneBy({ id, namespaceId: tx.namespaceId });
      if (!node) continue;
      const names: string[] = [];
      let parent = node;
      while (parent.parentId) {
        names.unshift(parent.name);
        const next = await nodeRepo.findOneBy({ id: parent.parentId, namespaceId: tx.namespaceId });
        if (!next) throw new Error('VFS parent node missing');
        parent = next;
      }
      result.push({ path: joinSegments(names), revision: encodeRevision(node) });
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
