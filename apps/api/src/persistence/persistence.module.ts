import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { loadDbConfig } from './db-config.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { BlobRepository } from './blob.repository.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { BackupRepository } from './backup.repository.js';

const ENTITIES = [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity];

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
            entities: ENTITIES,
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
          entities: ENTITIES,
        };
      },
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  providers: [
    NamespaceProvisioningRepository,
    VfsNodeRepository,
    BlobRepository,
    AuditLogRepository,
    BackupRepository,
    SqliteCaseSensitiveLikeInitializer,
  ],
  exports: [TypeOrmModule, NamespaceProvisioningRepository, VfsNodeRepository, BlobRepository, AuditLogRepository, BackupRepository],
})
export class PersistenceModule {}
