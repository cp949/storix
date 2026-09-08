import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { parsePositiveInt, requireEnv } from '../common/env-parsing.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: requireEnv('STORIX_DB_HOST'),
  port: parsePositiveInt(process.env.STORIX_DB_PORT, 5432),
  username: requireEnv('STORIX_DB_USERNAME'),
  password: requireEnv('STORIX_DB_PASSWORD'),
  database: requireEnv('STORIX_DB_NAME'),
  synchronize: false,
  entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
  migrations: [dirname + '/migrations/*.{ts,js}'],
});
