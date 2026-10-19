// 실제 in-memory SQLite와 migration으로 extract capture·DB deadline 공용 시나리오를 실행한다.
// 시나리오 본문은 extract-source.repository.shared-tests.ts다.
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ExtractSourceRepository } from '../../src/persistence/extract-source.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { runExtractSourceSharedTests } from './extract-source.repository.shared-tests.js';

describe('ExtractSourceRepository (SQLite)', () => {
  let dataSource: DataSource;
  let repository: ExtractSourceRepository;
  let nodeRepository: VfsNodeRepository;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    installSqliteGate(dataSource);
    repository = new ExtractSourceRepository(dataSource);
    nodeRepository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
      new ConfigService(),
    );
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  runExtractSourceSharedTests(() => ({ dataSource, repository, nodeRepository }));
});
