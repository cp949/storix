import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';

export interface VfsNodeRepositoryTestContext {
  readonly dataSource: DataSource;
  readonly repository: VfsNodeRepository;
}

export type VfsNodeRepositoryTestHelpers = ReturnType<typeof createVfsNodeRepositoryTestHelpers>;

export function createVfsNodeRepositoryTestHelpers(getContext: () => VfsNodeRepositoryTestContext) {
  function getDs(): DataSource {
    return getContext().dataSource;
  }

  function getRepo(): VfsNodeRepository {
    return getContext().repository;
  }

  async function createNamespace(name: string) {
    return new NamespaceProvisioningRepository(getDs()).createWithRoot(name);
  }

  async function createFile(namespaceId: string, parentId: string, name: string) {
    const blobRepo = getDs().getRepository(BlobEntity);
    const nodeRepo = getDs().getRepository(VfsNodeEntity);
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey: `blobs/00/${randomUUID()}`,
        size: '0',
        mimeType: 'application/octet-stream',
        sha256: '0'.repeat(64),
        referenceCount: 1,
      }),
    );
    return nodeRepo.save(
      nodeRepo.create({
        namespaceId,
        parentId,
        type: 'FILE',
        name,
        blobId: blob.id,
        size: '0',
        mimeType: 'application/octet-stream',
      }),
    );
  }

  async function captureState(namespaceId: string) {
    const nodes = await getDs()
      .getRepository(VfsNodeEntity)
      .find({
        where: { namespaceId },
        order: { id: 'ASC' },
      });
    const blobs = await getDs()
      .getRepository(BlobEntity)
      .find({
        where: { namespaceId },
        order: { id: 'ASC' },
      });
    return {
      nodes: nodes.map(({ id, parentId, name, type, blobId, version }) => ({
        id,
        parentId,
        name,
        type,
        blobId,
        version,
      })),
      blobs: blobs.map(({ id, referenceCount }) => ({ id, referenceCount })),
    };
  }

  async function runSameConditionAttempts<T>(namespaceId: string, attempt: () => Promise<T>) {
    if (getDs().options.type === 'better-sqlite3') {
      // SQLite는 root row 잠금이 없다. 쿼리 게이트가 두 시도를 한 줄로 세워, 동일한 조건을
      // 순서대로 재평가하는 계약을 실제 동시 시도로 확인한다.
      return Promise.allSettled([attempt(), attempt()]);
    }

    const holder = getDs().createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      const [{ pid }] = (await holder.query('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
      const lockedRoots = (await holder.query(
        'SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE',
        [namespaceId],
      )) as { id: string }[];
      expect(lockedRoots).toHaveLength(1);
      pending = Promise.allSettled([attempt(), attempt()]);
      const deadline = Date.now() + 5000;
      let blocked = 0;
      while (Date.now() < deadline) {
        // pg_stat_activity.query에는 bind 값이 표시되지 않는다. 위에서 이 namespace의
        // root row 하나를 잠근 holder PID로 차단 연쇄를 묶고, root 조회 SQL만 센다.
        const [{ count }] = (await getDs().query(
          `WITH RECURSIVE blocked AS (
             SELECT pid, unnest(pg_blocking_pids(pid)) AS blocker_pid
             FROM pg_stat_activity WHERE datname = current_database()
           ), root_waiters(pid) AS (
             SELECT pid FROM blocked WHERE blocker_pid = $1
             UNION
             SELECT b.pid FROM blocked b JOIN root_waiters w ON b.blocker_pid = w.pid
           )
           SELECT COUNT(DISTINCT a.pid)::int AS count
           FROM root_waiters w JOIN pg_stat_activity a ON a.pid = w.pid
           WHERE a.query LIKE '%vfs_node%'
             AND a.query LIKE '%namespace_id%'
             AND a.query LIKE '%parent_id%IS NULL%'
             AND a.query LIKE '%FOR UPDATE%'`,
          [pid],
        )) as { count: number }[];
        blocked = count;
        if (blocked >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(2);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
      if (pending) await pending;
    }
    return pending!;
  }

  function makeBlobData(
    overrides: Partial<{
      storageKey: string;
      size: string;
      mimeType: string;
      sha256: string;
      encryptionIv: Buffer | null;
    }> = {},
  ) {
    return {
      storageKey: `blobs/00/${randomUUID()}`,
      size: '0',
      mimeType: 'application/octet-stream',
      sha256: '0'.repeat(64),
      encryptionIv: null,
      ...overrides,
    };
  }
  return {
    getDs,
    getRepo,
    createNamespace,
    createFile,
    captureState,
    runSameConditionAttempts,
    makeBlobData,
  };
}
