// 실제 PostgreSQL과 migration으로 snapshot capture·DB wall-clock·과거 zero_since 경합을 검증한다.
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, IsNull } from 'typeorm';
import { ArchiveSourceRepository } from '../../src/persistence/archive-source.repository.js';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { encodeRevision } from '../../src/vfs/revision.js';

// DB 시계와 transaction 경계를 직접 관측해 capture·deadline의 전제를 고정한다.
describe('ArchiveSourceRepository PostgreSQL capture 검증', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  it('REPEATABLE READ transaction에서 source metadata와 deadline을 capture한다', async () => {
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      randomUUID(),
      `archive-${randomUUID()}`,
    );
    const root = await dataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: namespace.id, parentId: IsNull() });
    const blob = await dataSource.getRepository(BlobEntity).save(
      dataSource.getRepository(BlobEntity).create({
        namespaceId: namespace.id,
        storageKey: `blobs/${randomUUID()}`,
        size: '3',
        mimeType: 'text/plain',
        sha256: 'b'.repeat(64),
        referenceCount: 1,
      }),
    );
    const file = await dataSource.getRepository(VfsNodeEntity).save(
      dataSource.getRepository(VfsNodeEntity).create({
        namespaceId: namespace.id,
        parentId: root.id,
        type: 'FILE',
        name: 'source.txt',
        blobId: blob.id,
        size: '3',
        mimeType: 'text/plain',
      }),
    );
    const capture = await new ArchiveSourceRepository(dataSource).capture(
      namespace.id,
      root.id,
      {
        target: '/result.zip',
        entries: [{ id: file.id, name: 'source.txt', revision: encodeRevision(file) }],
      },
      { maxEntries: 10, maxSourceBytes: 10n, maxSeconds: 30 },
    );

    expect(capture.entries).toMatchObject([{ id: file.id, blobId: blob.id, plaintextBytes: 3n }]);
    expect(capture.deadlineAt.getTime()).toBeGreaterThan(Date.now());
  }, 30000);

  it('DB wall-clock으로 미래 deadline은 허용하고 과거 deadline은 거부한다', async () => {
    const repository = new ArchiveSourceRepository(dataSource);
    await dataSource.transaction(async (manager) => {
      const [{ now }] = (await manager.query('SELECT clock_timestamp() AS now')) as { now: Date }[];
      await expect(
        repository.assertDeadline(manager, new Date(now.getTime() + 60000)),
      ).resolves.toBeUndefined();
      await expect(repository.assertDeadline(manager, new Date(now.getTime() - 60000))).rejects.toMatchObject(
        {
          status: 503,
          code: 'VFS_ARCHIVE_TIMEOUT',
        },
      );
    });
  });

  it('열린 transaction에서도 시작 시각 대신 경과한 DB wall-clock을 검사한다', async () => {
    const repository = new ArchiveSourceRepository(dataSource);
    await dataSource.transaction(async (manager) => {
      const [{ deadline }] = (await manager.query(
        "SELECT transaction_timestamp() + interval '1 millisecond' AS deadline",
      )) as { deadline: Date }[];
      await manager.query('SELECT pg_sleep(0.01)');
      const [{ beforeDeadline }] = (await manager.query(
        'SELECT transaction_timestamp() < $1::timestamptz AS "beforeDeadline"',
        [deadline.toISOString()],
      )) as { beforeDeadline: boolean }[];
      expect(beforeDeadline).toBe(true);
      await expect(repository.assertDeadline(manager, deadline)).rejects.toMatchObject({
        status: 503,
        code: 'VFS_ARCHIVE_TIMEOUT',
      });
    });
  });

  it('capture 전에 시작한 삭제 transaction은 capture 이후 과거 zero_since로 커밋할 수 있다', async () => {
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      randomUUID(),
      `archive-race-${randomUUID()}`,
    );
    const root = await dataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: namespace.id, parentId: IsNull() });
    const blob = await dataSource.getRepository(BlobEntity).save(
      dataSource.getRepository(BlobEntity).create({
        namespaceId: namespace.id,
        storageKey: `blobs/${randomUUID()}`,
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'c'.repeat(64),
        referenceCount: 1,
      }),
    );
    const file = await dataSource.getRepository(VfsNodeEntity).save(
      dataSource.getRepository(VfsNodeEntity).create({
        namespaceId: namespace.id,
        parentId: root.id,
        type: 'FILE',
        name: 'source.bin',
        blobId: blob.id,
        size: '1',
        mimeType: 'application/octet-stream',
      }),
    );
    const deletion = dataSource.createQueryRunner();
    await deletion.connect();
    await deletion.startTransaction();
    try {
      const [{ startedAt }] = (await deletion.query('SELECT transaction_timestamp() AS "startedAt"')) as {
        startedAt: Date;
      }[];
      await deletion.query('SELECT pg_sleep(0.05)');
      const capture = await new ArchiveSourceRepository(dataSource).capture(
        namespace.id,
        root.id,
        { target: '/result.zip', entries: [{ id: file.id, name: 'source.bin' }] },
        { maxEntries: 10, maxSourceBytes: 10n, maxSeconds: 30 },
      );
      await deletion.query('DELETE FROM vfs_node WHERE id = $1', [file.id]);
      await deletion.query(
        'UPDATE blob SET reference_count = reference_count - 1, zero_since = CASE WHEN reference_count - 1 = 0 THEN CURRENT_TIMESTAMP ELSE zero_since END WHERE id = $1',
        [blob.id],
      );
      await deletion.commitTransaction();
      const [{ zeroSince }] = (await dataSource.query(
        'SELECT zero_since AS "zeroSince" FROM blob WHERE id = $1',
        [blob.id],
      )) as {
        zeroSince: Date;
      }[];

      expect(new Date(zeroSince).getTime()).toBeLessThan(capture.deadlineAt.getTime() - 30000);
      expect(new Date(zeroSince).getTime()).toBeLessThan(new Date(startedAt).getTime() + 1000);
    } catch (error) {
      if (deletion.isTransactionActive) await deletion.rollbackTransaction();
      throw error;
    } finally {
      await deletion.release();
    }
  }, 30000);
});
