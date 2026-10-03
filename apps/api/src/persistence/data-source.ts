import { NamespaceDeletionEntity } from './entities/namespace-deletion.entity.js';
import { NamespaceDeletionReceiptEntity } from './entities/namespace-deletion-receipt.entity.js';
import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadDbConfig } from './db-config.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { VfsMutationReceiptEntity } from './entities/vfs-mutation-receipt.entity.js';
import { VfsSnapshotEntity } from './entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from './entities/vfs-snapshot-entry.entity.js';
import { VfsTrashEntity } from './entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from './entities/vfs-trash-entry.entity.js';
import { VfsUploadSessionEntity } from './entities/vfs-upload-session.entity.js';
import { VfsUploadPartEntity } from './entities/vfs-upload-part.entity.js';
import { VfsUploadStagingCleanupEntity } from './entities/vfs-upload-staging-cleanup.entity.js';
import { VfsUploadUsageEntity } from './entities/vfs-upload-usage.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { resolveSecrets } from '../secrets/resolve-secrets.js';

const entities = [
  NamespaceEntity,
  NamespaceDeletionEntity,
  NamespaceDeletionReceiptEntity,
  VfsNodeEntity,
  BlobEntity,
  IdempotencyKeyEntity,
  AuditLogEntity,
  VfsMutationReceiptEntity,
  VfsSnapshotEntity,
  VfsSnapshotEntryEntity,
  VfsTrashEntity,
  VfsTrashEntryEntity,
  VfsUploadSessionEntity,
  VfsUploadPartEntity,
  VfsUploadStagingCleanupEntity,
  VfsUploadUsageEntity,
];
const migrations = ALL_MIGRATIONS;

function buildOptions(): DataSourceOptions {
  const dbConfig = loadDbConfig();

  if (dbConfig.driver === 'sqlite') {
    return {
      type: 'better-sqlite3',
      database: dbConfig.sqlitePath,
      synchronize: false,
      entities,
      migrations,
      migrationsTransactionMode: 'each',
    };
  }
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.database,
    synchronize: false,
    entities,
    migrations,
  };
}

// typeorm CLI(migrate 서비스, migration:run·generate) 경로는 bootstrapWithEnv()를 거치지 않는다.
// CLI가 이 파일을 ESM import()로 열므로 최상위 await로 비밀값을 먼저 해석한다.
// 엔티티 정적 import는 이 줄보다 먼저 평가된다. 엔티티가 읽는 STORIX_DB_DRIVER는 비밀값이 아니라서 충돌하지 않는다.
// 앱 런타임은 이 파일을 import하지 않는다. 해석은 진입점마다 한 번이다.
await resolveSecrets();

export const AppDataSource = new DataSource(buildOptions());
