import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { parsePositiveInt } from '../common/env-parsing.js';
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

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        if (config.get<string>('STORIX_DB_DRIVER') === 'sqlite') {
          return {
            type: 'better-sqlite3' as const,
            database: config.getOrThrow<string>('STORIX_DB_SQLITE_PATH'),
            synchronize: false,
            entities: ENTITIES,
          };
        }
        return {
          type: 'postgres' as const,
          host: config.getOrThrow<string>('STORIX_DB_HOST'),
          port: parsePositiveInt(config.get<string>('STORIX_DB_PORT'), 5432),
          username: config.getOrThrow<string>('STORIX_DB_USERNAME'),
          password: config.getOrThrow<string>('STORIX_DB_PASSWORD'),
          database: config.getOrThrow<string>('STORIX_DB_NAME'),
          synchronize: false,
          entities: ENTITIES,
        };
      },
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  providers: [NamespaceProvisioningRepository, VfsNodeRepository, BlobRepository, AuditLogRepository, BackupRepository],
  exports: [TypeOrmModule, NamespaceProvisioningRepository, VfsNodeRepository, BlobRepository, AuditLogRepository, BackupRepository],
})
export class PersistenceModule {}
