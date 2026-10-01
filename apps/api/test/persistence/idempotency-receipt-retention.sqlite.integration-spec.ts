import { DataSource } from 'typeorm';
import { IdempotencyReceiptRetentionRepository } from '../../src/persistence/idempotency-receipt-retention.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { runIdempotencyReceiptRetentionSharedTests } from './idempotency-receipt-retention.shared-tests.js';

// STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행에서만 돈다(blob.repository.sqlite.integration-spec.ts와 같은 관례).
describe('IdempotencyReceiptRetentionRepository (SQLite)', () => {
  let dataSource: DataSource;
  let repository: IdempotencyReceiptRetentionRepository;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error('STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행할 수 없다');
    }
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
    repository = new IdempotencyReceiptRetentionRepository(dataSource);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  runIdempotencyReceiptRetentionSharedTests(() => ({ dataSource, repository, sqlite: true }));
});
