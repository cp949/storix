import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
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
      entities: [
        NamespaceEntity,
        VfsNodeEntity,
        BlobEntity,
        IdempotencyKeyEntity,
        VfsTrashEntity,
        VfsTrashEntryEntity,
      ],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    repository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
      new ConfigService(),
    );
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runVfsNodeRepositorySharedTests(() => ({ dataSource, repository }));
});
