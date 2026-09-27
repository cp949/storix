import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { registerChangeFeedHttpContract } from './change-feed-http.test-support.js';

const API_KEY = 'change-feed-pg-integration-key';

describe('Change feed HTTP contract (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let migration: DataSource;
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
    }).overrideProvider(CapabilityService).useValue(capabilities).compile();
    const next = module.createNestApplication();
    await next.init();
    return next;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    Object.assign(process.env, {
      STORIX_DB_HOST: container.getHost(), STORIX_DB_PORT: String(container.getPort()),
      STORIX_DB_USERNAME: container.getUsername(), STORIX_DB_PASSWORD: container.getPassword(),
      STORIX_DB_NAME: container.getDatabase(), STORIX_API_KEY: API_KEY,
      STORIX_ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      STORIX_STORAGE_ENDPOINT: '127.0.0.1', STORIX_STORAGE_PORT: '9000',
      STORIX_STORAGE_ACCESS_KEY: 'test-access', STORIX_STORAGE_SECRET_KEY: 'test-secret',
      STORIX_STORAGE_BUCKET: 'change-feed-test',
    });
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    migration = new DataSource({ type: 'postgres', url: container.getConnectionUri(),
      migrations: ALL_MIGRATIONS });
    await migration.initialize();
    await migration.runMigrations();
    app = await bootstrap();
    const create = async () => (await request(app.getHttpServer()).post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`).set('Idempotency-Key', randomUUID())
      .send({ name: randomUUID() }).expect(201)).body.id as string;
    enabledId = await create();
    otherId = await create();
    disabledId = await create();
    await app.close();
    app = await bootstrap([enabledId, otherId]);
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    if (migration?.isInitialized) await migration.destroy();
    if (container) await container.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  registerChangeFeedHttpContract(() => ({ app, enabledId, otherId, disabledId, apiKey: API_KEY }));
});
