/**
 * 전용 PostgreSQL 16 컨테이너와 제어 저장소로 staging 정산 계약을 검증한다.
 * 규칙은 docs/design/07-resumable-upload.md "staging 정리 module".
 */
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { stagingCleanupTests } from './upload-staging-cleanup.shared-tests.js';

// 실제 usage 행 잠금 아래에서 정착 관측과 단일 반환을 확인한다.
describe('UploadStagingCleanup PostgreSQL 정산 검증', () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
  });
  afterAll(async () => {
    await postgres?.stop();
  });
  stagingCleanupTests(async () => {
    // 이 suite 전용 컨테이너의 DB만 초기화한다.
    const db = await new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
      dropSchema: true,
      synchronize: false,
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
    }).initialize();
    await db.runMigrations();
    return db;
  });
});
