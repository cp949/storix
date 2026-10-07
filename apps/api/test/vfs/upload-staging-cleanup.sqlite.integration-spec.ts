/**
 * 실제 SQLite 메모리 DB와 연결 게이트·제어 저장소로 staging 정산 계약을 검증한다.
 * 규칙은 docs/design/07-resumable-upload.md "staging 정리 module".
 */
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';
import { stagingCleanupTests } from './upload-staging-cleanup.shared-tests.js';

// SQLite gate 아래에서 경합의 객체·row·카운터를 함께 확인한다.
describe('UploadStagingCleanup SQLite 정산 검증', () => {
  stagingCleanupTests(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    const db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
      migrationsTransactionMode: 'each',
    }).initialize();
    await db.runMigrations();
    installSqliteGate(db);
    return db;
  });
});
