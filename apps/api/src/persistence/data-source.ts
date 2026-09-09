import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { getDbDriver } from '../common/db-driver.js';
import { parsePositiveInt, requireEnv } from '../common/env-parsing.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const entities = [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity];
const migrations = [dirname + '/migrations/*.{ts,js}'];

function buildOptions(): DataSourceOptions {
  if (getDbDriver() === 'sqlite') {
    return {
      type: 'better-sqlite3',
      database: requireEnv('STORIX_DB_SQLITE_PATH'),
      synchronize: false,
      entities,
      migrations,
      migrationsTransactionMode: 'each',
    };
  }
  return {
    type: 'postgres',
    host: requireEnv('STORIX_DB_HOST'),
    port: parsePositiveInt(process.env.STORIX_DB_PORT, 5432),
    username: requireEnv('STORIX_DB_USERNAME'),
    password: requireEnv('STORIX_DB_PASSWORD'),
    database: requireEnv('STORIX_DB_NAME'),
    synchronize: false,
    entities,
    migrations,
  };
}

export const AppDataSource = new DataSource(buildOptions());
