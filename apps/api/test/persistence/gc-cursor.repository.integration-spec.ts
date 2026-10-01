import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { GcCursorRepository } from '../../src/persistence/gc-cursor.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { runGcCursorRepositorySharedTests } from './gc-cursor.repository.shared-tests.js';

describe('GcCursorRepository (Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: GcCursorRepository;

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
    repository = new GcCursorRepository(dataSource);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runGcCursorRepositorySharedTests(() => ({ repository }));
});
