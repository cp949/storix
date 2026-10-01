/**
 * 공유 삭제 접수 repository 테스트를 메모리 SQLite에서 실행한다.
 * 규칙은 docs/design/13-namespace-deletion.md "영속 상태와 잠금". 결정은 api ADR-0032.
 */
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { VfsUploadPartEntity } from '../../src/persistence/entities/vfs-upload-part.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
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
        BlobEntity,
        VfsUploadSessionEntity,
        VfsUploadPartEntity,
        VfsChangeFeedStateEntity,
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
