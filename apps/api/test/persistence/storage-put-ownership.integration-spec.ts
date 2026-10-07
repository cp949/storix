/** PostgreSQL 16에서 PUT 소유권 전이와 동시 회수 배제를 검증한다. 규칙은 api ADR-0045다. */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';
import { runStoragePutOwnershipRepositorySharedTests } from './storage-put-ownership.shared-tests.js';

// PostgreSQL 16 migration과 동시 트랜잭션에서 소유권 전이와 경쟁 상태를 확인한다.
describe('StoragePutOwnershipRepository (Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runStoragePutOwnershipRepositorySharedTests(
    () => new StoragePutOwnershipRepository(dataSource),
    () => dataSource,
  );
});
