import { ConfigService } from '@nestjs/config';
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
import { resolveGlobalTotalLogicalByteLimit, resolveNamespaceQuota } from '../vfs/namespace-quota.js';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import type { VfsNodeType } from './entities/vfs-node.entity.js';
import type { MutationTx, AffectedRevision } from './vfs-node.repository.types.js';
import { joinSegments } from './vfs-node.repository.helpers.js';

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
        const root = await this.applyRowLockIfSupported(
          manager
            .createQueryBuilder(VfsNodeEntity, 'n')
            .where('n.namespace_id = :namespaceId AND n.parent_id IS NULL', { namespaceId }),
        ).getOne();
        if (!root || root.type !== 'DIRECTORY') {
          throw new VfsNodeNotFoundError('/');
        }
        const tx: MutationTx = {
          manager,
          namespaceId,
          rootId,
          changed: new Map(),
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
        return { value, affectedRevisions };
      });
    } catch (error) {
      // work/afterBump는 클라이언트 업로드 stream을 소비할 수 있다. callback의 원시 transport 코드는
      // DB에서 났다는 근거가 없으므로 driverError가 없으면 분류하지 않는다.
      if (error === callbackError && !(error as { driverError?: unknown })?.driverError) throw error;
      throw classifyPersistenceFailure(error) ?? error;
    }
  }

  protected recordLiveByteDelta(tx: MutationTx, delta: bigint): void {
    tx.liveFileByteDelta += delta;
    tx.logicalByteDelta += delta;
  }

  private async applyLogicalByteQuota(tx: MutationTx): Promise<void> {
    if (tx.logicalByteDelta <= 0n && tx.liveFileByteDelta === 0n) return;

    const namespaces = tx.manager.getRepository(NamespaceEntity);
    const namespace = await namespaces.findOneByOrFail({ id: tx.namespaceId });
    const liveBytes = BigInt(String(namespace.liveFileByteCount)) + tx.liveFileByteDelta;
    const retainedBytes = BigInt(String(namespace.retainedSnapshotByteCount));
    if (liveBytes < 0n || liveBytes > 9223372036854775807n) {
      throw new Error('namespace live file byte counter out of int64 range');
    }
    const totalBytes = liveBytes + retainedBytes;
    if (totalBytes > 9223372036854775807n) {
      throw new Error('namespace total logical byte counter out of int64 range');
    }

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
      this.markChanged(tx, currentId, true);
      const current: VfsNodeEntity | null = await nodeRepo.findOneBy({
        id: currentId,
        namespaceId: tx.namespaceId,
      });
      if (!current) throw new VfsNodeNotFoundError('/');
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
