import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsChangeEventEntity } from '../../src/persistence/entities/vfs-change-event.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsChangeFeedRetentionRepository } from '../../src/persistence/vfs-change-feed-retention.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { runVfsChangeFeedGcSharedTests } from './vfs-change-feed-gc.shared-tests.js';

describe('VFS change feed GC (Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let nodes: VfsNodeRepository;
  let retention: VfsChangeFeedRetentionRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres', url: container.getConnectionUri(), synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, VfsChangeFeedStateEntity, VfsChangeEventEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    nodes = new VfsNodeRepository(dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity), dataSource.getRepository(BlobEntity), dataSource,
      new BlobRepository(dataSource), new ConfigService());
    retention = new VfsChangeFeedRetentionRepository(dataSource);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runVfsChangeFeedGcSharedTests(() => ({ dataSource, nodes, retention, sqlite: false }));
});
