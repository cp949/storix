import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { runVfsNodeRepositorySharedTests } from './vfs-node.repository.shared-tests.js';

describe('VfsNodeRepository (Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: VfsNodeRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS.slice(0, 3),
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    repository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
    );
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runVfsNodeRepositorySharedTests(() => ({ dataSource, repository }));
});
