import { NamespaceDeletionCleanupRepository } from './namespace-deletion-cleanup.repository.js';
import { NamespaceDeletionRepository } from './namespace-deletion.repository.js';
import { VfsSnapshotRepository } from './vfs-snapshot.repository.js';
import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { loadDbConfig } from './db-config.js';
import { installSqliteGate } from './sqlite-gate.js';
import { ALL_ENTITIES } from './entities/all-entities.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { AUDIT_LOG_REPOSITORY } from './audit-log.tokens.js';
import { BlobRepository } from './blob.repository.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { NamespaceCreationReceiptWriter } from './namespace-creation-receipt.writer.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { BackupRepository } from './backup.repository.js';
import { VfsMutationReceiptRepository } from './vfs-mutation-receipt.repository.js';
import { VfsUploadSessionRepository } from './vfs-upload-session.repository.js';
import { VfsChangeFeedRetentionRepository } from './vfs-change-feed-retention.repository.js';
import { GcCursorRepository } from './gc-cursor.repository.js';
import { IdempotencyReceiptRetentionRepository } from './idempotency-receipt-retention.repository.js';
import { NamespacePurgeRepository } from './namespace-purge.repository.js';
import { VfsTrashRepository } from './vfs-trash.repository.js';
import { VfsTrashRetentionRepository } from './vfs-trash-retention.repository.js';
import { VfsFileExpiryRepository } from './vfs-file-expiry.repository.js';
import { StoragePutOwnershipRepository } from './storage-put-ownership.repository.js';

// SQLite는 기본적으로 ASCII 대소문자 무시로 LIKE를 평가한다(Postgres는 대소문자
// 구분) — findRecursive의 name 필터(contains/prefix/suffix)가 두 드라이버에서
// 같은 결과를 내도록 연결 직후 한 번 이 PRAGMA를 켠다.
@Injectable()
class SqliteCaseSensitiveLikeInitializer implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    if (isSqliteDataSource(this.dataSource.options)) {
      await this.dataSource.query('PRAGMA case_sensitive_like = ON');
    }
  }
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      // data-source.ts와 동일하게 loadDbConfig()(process.env 직접 읽음)를 쓴다.
      // entities의 컬럼 타입은 이 모듈이 import되는 시점(ConfigModule.forRoot 실행 전)에
      // getDbDriver()로 이미 확정되므로, 여기서 ConfigService(.env 로드 후 값)를 쓰면
      // 두 값이 어긋나 better-sqlite3 연결에 Postgres 타입 엔티티가 붙는 사고가 난다.
      useFactory: () => {
        const dbConfig = loadDbConfig();

        if (dbConfig.driver === 'sqlite') {
          return {
            type: 'better-sqlite3' as const,
            database: dbConfig.sqlitePath,
            synchronize: false,
            entities: ALL_ENTITIES,
          };
        }
        return {
          type: 'postgres' as const,
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database,
          synchronize: false,
          entities: ALL_ENTITIES,
        };
      },
      // SQLite는 연결 하나를 모든 요청이 공유하므로 초기화 직후 쿼리 직렬화 게이트를 건다(PostgreSQL은 무변경).
      dataSourceFactory: async (options) => {
        const dataSource = await new DataSource(options as DataSourceOptions).initialize();
        if (isSqliteDataSource(dataSource.options)) installSqliteGate(dataSource);
        return dataSource;
      },
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
  ],
  providers: [
    NamespaceProvisioningRepository,
    NamespaceDeletionRepository,
    NamespaceDeletionCleanupRepository,
    NamespaceCreationReceiptWriter,
    VfsNodeRepository,
    BlobRepository,
    AuditLogRepository,
    { provide: AUDIT_LOG_REPOSITORY, useExisting: AuditLogRepository },
    BackupRepository,
    VfsMutationReceiptRepository,
    VfsSnapshotRepository,
    VfsTrashRepository,
    VfsTrashRetentionRepository,
    VfsFileExpiryRepository,
    VfsUploadSessionRepository,
    VfsChangeFeedRetentionRepository,
    GcCursorRepository,
    IdempotencyReceiptRetentionRepository,
    NamespacePurgeRepository,
    StoragePutOwnershipRepository,
    SqliteCaseSensitiveLikeInitializer,
  ],
  exports: [
    TypeOrmModule,
    NamespaceProvisioningRepository,
    NamespaceDeletionRepository,
    NamespaceDeletionCleanupRepository,
    NamespaceCreationReceiptWriter,
    VfsNodeRepository,
    BlobRepository,
    AuditLogRepository,
    AUDIT_LOG_REPOSITORY,
    BackupRepository,
    VfsMutationReceiptRepository,
    VfsSnapshotRepository,
    VfsTrashRepository,
    VfsTrashRetentionRepository,
    VfsFileExpiryRepository,
    VfsUploadSessionRepository,
    VfsChangeFeedRetentionRepository,
    GcCursorRepository,
    IdempotencyReceiptRetentionRepository,
    NamespacePurgeRepository,
    StoragePutOwnershipRepository,
  ],
})
export class PersistenceModule {}
