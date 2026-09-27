import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { VfsChangeEventEntity } from '../../src/persistence/entities/vfs-change-event.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { runVfsChangeFeedRepositorySharedTests } from './vfs-change-feed.repository.shared-tests.js';

describe('VFS change feed persistence (SQLite)', () => {
  let dataSource: DataSource;
  let repository: VfsNodeRepository;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('STORIX_DB_DRIVER=sqlite required');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [
        NamespaceEntity,
        VfsNodeEntity,
        BlobEntity,
        VfsChangeFeedStateEntity,
        VfsChangeEventEntity,
        VfsTrashEntity,
        VfsTrashEntryEntity,
      ],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    installSqliteGate(dataSource);
    repository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
      new ConfigService(),
    );
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  runVfsChangeFeedRepositorySharedTests(() => ({ dataSource, repository }));
});
