import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespacePurgeRepository } from '../../src/persistence/namespace-purge.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { runNamespacePurgeSharedTests } from './namespace-purge.repository.shared-tests.js';

describe('NamespacePurgeRepository (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: NamespacePurgeRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    repository = new NamespacePurgeRepository(dataSource);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runNamespacePurgeSharedTests(() => ({ dataSource, repository, sqlite: false }));
});
