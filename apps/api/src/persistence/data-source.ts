import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadDbConfig } from './db-config.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';

const entities = [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity];
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

export const AppDataSource = new DataSource(buildOptions());
