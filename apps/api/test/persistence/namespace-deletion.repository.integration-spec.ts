/** 실제 PostgreSQL에서 삭제 접수의 영속 상태·receipt 트랜잭션을 검증한다. */
import { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceDeletionEntity } from '../../src/persistence/entities/namespace-deletion.entity.js';
import { NamespaceDeletionReceiptEntity } from '../../src/persistence/entities/namespace-deletion-receipt.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { registerNamespaceDeletionRepositoryTests } from './namespace-deletion.repository.shared-tests.js';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

describe('namespace 삭제 repository (PostgreSQL)', () => {
  let db: DataSource;
  let container: StartedPostgreSqlContainer;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    db = await new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      entities: [
        NamespaceEntity,
        VfsNodeEntity,
        NamespaceDeletionEntity,
        NamespaceDeletionReceiptEntity,
        VfsUploadUsageEntity,
      ],
      migrations: ALL_MIGRATIONS,
    }).initialize();
    await db.runMigrations();
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (container) await container.stop();
  });
  registerNamespaceDeletionRepositoryTests(() => db);
});
