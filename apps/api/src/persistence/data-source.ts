import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { parsePositiveInt, requireEnv } from '../common/env-parsing.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: requireEnv('DB_HOST'),
  port: parsePositiveInt(process.env.DB_PORT, 5432),
  username: requireEnv('DB_USERNAME'),
  password: requireEnv('DB_PASSWORD'),
  database: requireEnv('DB_NAME'),
  synchronize: false,
  entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
  migrations: [dirname + '/migrations/*.{ts,js}'],
});
