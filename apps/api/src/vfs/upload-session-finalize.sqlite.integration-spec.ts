import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { CapabilityService } from '../capability/capability.service.js';
import { configureBodyParsers } from '../common/body-parser.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { UPLOAD_SESSION_POLICY, type UploadSessionPolicy } from './upload-session-config.js';
import { registerFinalizeTests } from './upload-session-finalize.shared-tests.js';
import { VfsModule } from './vfs.module.js';

describe('upload finalize (SQLite + MinIO)', () => {
  const previous = { ...process.env };
  let directory: string;
  let minio: StartedMinioContainer;
  let migrations: DataSource;
  let app: INestApplication;
  let plainId: string;
  let encryptedId: string;

  function policy(): UploadSessionPolicy {
    return {
      global: {
        maxStagedBytes: 1024n,
        maxActiveSessions: 30,
        partSizeBytes: 4,
        inactivitySeconds: 60,
        maxLifetimeSeconds: 120,
      },
      namespaces: {
        [plainId]: { maxStagedBytes: 1024n, maxActiveSessions: 30 },
        [encryptedId]: { maxStagedBytes: 1024n, maxActiveSessions: 30 },
      },
    };
  }
  async function bootstrap(enabled: boolean) {
    const builder = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule, VfsModule],
    });
    if (plainId) {
      builder.overrideProvider(CapabilityService).useValue(
        new CapabilityService({
          globalAllowedCapabilities: enabled ? ['resumable-upload'] : [],
          namespaceAllowedCapabilities: {
            [plainId]: enabled ? ['resumable-upload'] : [],
            [encryptedId]: enabled ? ['resumable-upload'] : [],
          },
        }),
      );
      builder.overrideProvider(UPLOAD_SESSION_POLICY).useValue(policy());
    }
    const module = await builder.compile();
    const next = module.createNestApplication({ bodyParser: false });
    configureBodyParsers(next);
    await next.init();
    return next;
  }
  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    directory = await mkdtemp(join(tmpdir(), 'storix-upload-finalize-'));
    minio = await new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start();
    Object.assign(process.env, {
      STORIX_DB_SQLITE_PATH: join(directory, 'finalize.sqlite'),
      STORIX_STORAGE_ENDPOINT: minio.getHost(),
      STORIX_STORAGE_PORT: String(minio.getPort()),
      STORIX_STORAGE_USE_SSL: 'false',
      STORIX_STORAGE_ACCESS_KEY: minio.getUsername(),
      STORIX_STORAGE_SECRET_KEY: minio.getPassword(),
      STORIX_STORAGE_BUCKET: 'storix-upload-finalize',
      STORIX_ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      STORIX_API_KEY: 'upload-finalize-integration-key',
    });
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    delete process.env.STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH;
    const client = new MinioClient({
      endPoint: minio.getHost(),
      port: minio.getPort(),
      useSSL: false,
      accessKey: minio.getUsername(),
      secretKey: minio.getPassword(),
    });
    await client.makeBucket('storix-upload-finalize');
    migrations = new DataSource({
      type: 'better-sqlite3',
      database: process.env.STORIX_DB_SQLITE_PATH!,
      migrations: ALL_MIGRATIONS,
      migrationsTransactionMode: 'each',
    });
    await migrations.initialize();
    await migrations.runMigrations();
    await migrations.destroy();
    app = await bootstrap(false);
    const createNamespace = (name: string, encryptionPolicy?: string) =>
      request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Authorization', 'Bearer upload-finalize-integration-key')
        .set('Idempotency-Key', randomUUID())
        .send({ name, ...(encryptionPolicy ? { encryptionPolicy } : {}) });
    plainId = (await createNamespace('upload-finalize-plain').expect(201)).body.id as string;
    encryptedId = (await createNamespace('upload-finalize-encrypted', 'ENCRYPTED').expect(201)).body
      .id as string;
    await app.close();
    app = await bootstrap(true);
  }, 180000);
  afterAll(async () => {
    if (app) await app.close();
    if (migrations?.isInitialized) await migrations.destroy();
    if (minio) await minio.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  registerFinalizeTests({
    app: () => app,
    namespace: () => plainId,
    encryptedNamespace: () => encryptedId,
    restartDisabled: async () => {
      await app.close();
      app = await bootstrap(false);
    },
    restartEnabled: async () => {
      await app.close();
      app = await bootstrap(true);
    },
  });
});
