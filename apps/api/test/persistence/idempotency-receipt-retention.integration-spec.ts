import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { IdempotencyReceiptRetentionRepository } from '../../src/persistence/idempotency-receipt-retention.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { runIdempotencyReceiptRetentionSharedTests } from './idempotency-receipt-retention.shared-tests.js';

describe('IdempotencyReceiptRetentionRepository (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: IdempotencyReceiptRetentionRepository;

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
    repository = new IdempotencyReceiptRetentionRepository(dataSource);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runIdempotencyReceiptRetentionSharedTests(() => ({ dataSource, repository, sqlite: false }));
});
