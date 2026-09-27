import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsSnapshotEntity } from '../../src/persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../../src/persistence/entities/vfs-snapshot-entry.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsSnapshotRepository } from '../../src/persistence/vfs-snapshot.repository.js';
import { runSnapshotRepositoryTests } from './vfs-snapshot.repository.shared-tests.js';

describe('VfsSnapshotRepository (PostgreSQL)', () => {
  let dataSource: DataSource;
  let nodes: VfsNodeRepository;
  let snapshots: VfsSnapshotRepository;
  let container: StartedPostgreSqlContainer;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, VfsSnapshotEntity, VfsSnapshotEntryEntity,
        VfsTrashEntity, VfsTrashEntryEntity],
      migrations: ALL_MIGRATIONS,
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    const blobs = new BlobRepository(dataSource);
    nodes = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      blobs,
      new ConfigService(),
    );
    snapshots = new VfsSnapshotRepository(dataSource, blobs);
  }, 120000);
  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });
  runSnapshotRepositoryTests(() => ({ dataSource, nodes, snapshots }));
});
