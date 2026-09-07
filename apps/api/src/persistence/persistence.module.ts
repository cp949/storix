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

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.getOrThrow<string>('DB_HOST'),
        port: parsePositiveInt(config.get<string>('DB_PORT'), 5432),
        username: config.getOrThrow<string>('DB_USERNAME'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        database: config.getOrThrow<string>('DB_NAME'),
        synchronize: false,
        entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity]),
  ],
  providers: [NamespaceProvisioningRepository, VfsNodeRepository, BlobRepository, AuditLogRepository, BackupRepository],
  exports: [TypeOrmModule, NamespaceProvisioningRepository, VfsNodeRepository, BlobRepository, AuditLogRepository, BackupRepository],
})
export class PersistenceModule {}
