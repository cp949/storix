import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { GcJobModule } from '../../src/jobs/gc-job.module.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { UPLOAD_SESSION_POLICY, type UploadSessionPolicy } from '../../src/vfs/upload-session-config.js';
import { registerFinalizeTests } from './upload-session-finalize.shared-tests.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';

describe('upload finalize (PostgreSQL + S3)', () => {
  const previous = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let s3Container: StartedS3Container;
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
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        AuthModule,
        NamespaceModule,
        VfsModule,
        GcJobModule,
      ],
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
    [postgres, s3Container] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      startS3Container(),
    ]);
    Object.assign(process.env, {
      STORIX_DB_HOST: postgres.getHost(),
      STORIX_DB_PORT: String(postgres.getPort()),
      STORIX_DB_USERNAME: postgres.getUsername(),
      STORIX_DB_PASSWORD: postgres.getPassword(),
      STORIX_DB_NAME: postgres.getDatabase(),
      STORIX_STORAGE_ENDPOINT: s3Container.getHost(),
      STORIX_STORAGE_PORT: String(s3Container.getPort()),
      STORIX_STORAGE_USE_SSL: 'false',
      STORIX_STORAGE_ACCESS_KEY: s3Container.getUsername(),
      STORIX_STORAGE_SECRET_KEY: s3Container.getPassword(),
      STORIX_STORAGE_BUCKET: 'storix-upload-finalize',
      STORIX_ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      STORIX_API_KEY: 'upload-finalize-integration-key',
    });
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    delete process.env.STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH;
    const client = createTestS3Client(s3Container);
    await createTestBucket(client, 'storix-upload-finalize');
    migrations = new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
      migrations: ALL_MIGRATIONS,
    });
    await migrations.initialize();
    await migrations.runMigrations();
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
    await Promise.all([postgres?.stop(), s3Container?.stop()]);
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
