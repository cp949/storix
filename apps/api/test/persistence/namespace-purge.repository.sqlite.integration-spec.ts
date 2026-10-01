import { DataSource } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespacePurgeRepository } from '../../src/persistence/namespace-purge.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { runNamespacePurgeSharedTests } from './namespace-purge.repository.shared-tests.js';

// STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행에서만 돈다(blob.repository.sqlite.integration-spec.ts와 같은 관례).
describe('NamespacePurgeRepository (SQLite)', () => {
  let dataSource: DataSource;
  let repository: NamespacePurgeRepository;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error('STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행할 수 없다');
    }
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    repository = new NamespacePurgeRepository(dataSource);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  runNamespacePurgeSharedTests(() => ({ dataSource, repository, sqlite: true }));
});
