/** 실제 SQLite에서 PUT 소유권 전이와 key 회수 배제를 검증한다. 규칙은 api ADR-0045다. */
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';
import { runStoragePutOwnershipRepositorySharedTests } from './storage-put-ownership.shared-tests.js';

// TypeORM migration이 만든 SQLite 테이블에서 소유권 전이와 경쟁 상태를 확인한다.
describe('StoragePutOwnershipRepository (SQLite)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('STORIX_DB_DRIVER=sqlite가 필요하다');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    installSqliteGate(dataSource);
  }, 30000);

  afterAll(async () => dataSource.destroy());

  runStoragePutOwnershipRepositorySharedTests(
    () => new StoragePutOwnershipRepository(dataSource),
    () => dataSource,
  );
});
