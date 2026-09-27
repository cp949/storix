import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { registerChangeFeedHttpContract } from './change-feed-http.test-support.js';

const API_KEY = 'change-feed-sqlite-integration-key';

describe('Change feed HTTP contract (SQLite)', () => {
  let directory: string;
  let app: INestApplication;
  let enabledId: string;
  let otherId: string;
  let disabledId: string;
  const previous = { ...process.env };

  async function bootstrap(ids: string[] = []): Promise<INestApplication> {
    const capabilities = new CapabilityService({
      globalAllowedCapabilities: ids.length === 0 ? [] : ['change-feed'],
      namespaceAllowedCapabilities: Object.fromEntries(ids.map((id) => [id, ['change-feed']])),
    });
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule, VfsModule],
    })
      .overrideProvider(CapabilityService)
      .useValue(capabilities)
      .compile();
    const next = module.createNestApplication();
    await next.init();
    return next;
  }

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('Run with STORIX_DB_DRIVER=sqlite');
    directory = await mkdtemp(join(tmpdir(), 'storix-change-feed-'));
    Object.assign(process.env, {
      STORIX_DB_SQLITE_PATH: join(directory, 'feed.sqlite'),
      STORIX_API_KEY: API_KEY,
      STORIX_ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      STORIX_STORAGE_ENDPOINT: '127.0.0.1',
      STORIX_STORAGE_PORT: '9000',
      STORIX_STORAGE_ACCESS_KEY: 'test-access',
      STORIX_STORAGE_SECRET_KEY: 'test-secret',
      STORIX_STORAGE_BUCKET: 'change-feed-test',
    });
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    const migration = new DataSource({
      type: 'better-sqlite3',
      database: join(directory, 'feed.sqlite'),
      migrations: ALL_MIGRATIONS,
      migrationsTransactionMode: 'each',
    });
    await migration.initialize();
    try {
      await migration.runMigrations();
    } finally {
      await migration.destroy();
    }
    app = await bootstrap();
    const create = async () =>
      (
        await request(app.getHttpServer())
          .post('/api/v2/namespaces')
          .set('Authorization', `Bearer ${API_KEY}`)
          .set('Idempotency-Key', randomUUID())
          .send({ name: randomUUID() })
          .expect(201)
      ).body.id as string;
    enabledId = await create();
    otherId = await create();
    disabledId = await create();
    await app.close();
    app = await bootstrap([enabledId, otherId]);
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  registerChangeFeedHttpContract(() => ({ app, enabledId, otherId, disabledId, apiKey: API_KEY }));
});
