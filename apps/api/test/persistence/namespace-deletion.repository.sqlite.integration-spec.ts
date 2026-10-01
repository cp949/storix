/** 실제 SQLite와 연결 게이트에서 삭제 접수의 영속 상태·receipt 트랜잭션을 검증한다. */
import { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceDeletionEntity } from '../../src/persistence/entities/namespace-deletion.entity.js';
import { NamespaceDeletionReceiptEntity } from '../../src/persistence/entities/namespace-deletion-receipt.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { registerNamespaceDeletionRepositoryTests } from './namespace-deletion.repository.shared-tests.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';

describe('namespace 삭제 repository (SQLite)', () => {
  let db: DataSource;
  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        NamespaceEntity,
        VfsNodeEntity,
        NamespaceDeletionEntity,
        NamespaceDeletionReceiptEntity,
        VfsUploadUsageEntity,
      ],
      migrations: ALL_MIGRATIONS,
      migrationsTransactionMode: 'each',
    }).initialize();
    await db.runMigrations();
    installSqliteGate(db);
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });
  registerNamespaceDeletionRepositoryTests(() => db);
});
