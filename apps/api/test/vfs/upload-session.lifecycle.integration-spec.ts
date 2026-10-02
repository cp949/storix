import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
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
import { GcJob } from '../../src/jobs/gc.job.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import { UPLOAD_SESSION_POLICY, type UploadSessionPolicy } from '../../src/vfs/upload-session-config.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';

const API_KEY = 'upload-session-integration-key';

describe('upload session lifecycle (PostgreSQL + S3)', () => {
  const previousEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let s3Container: StartedS3Container;
  let migrations: DataSource;
  let app: INestApplication;
  let namespaceId: string;

  function policy(): UploadSessionPolicy {
    return {
      global: {
        maxStagedBytes: 1024n,
        maxActiveSessions: 3,
        partSizeBytes: 4,
        inactivitySeconds: 60,
        maxLifetimeSeconds: 120,
      },
      namespaces: { [namespaceId]: { maxStagedBytes: 1024n, maxActiveSessions: 3 } },
    };
  }

  async function bootstrap(enabled: boolean): Promise<INestApplication> {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        AuthModule,
        NamespaceModule,
        VfsModule,
        GcJobModule,
      ],
    });
    if (namespaceId) {
      builder.overrideProvider(CapabilityService).useValue(
        new CapabilityService({
          globalAllowedCapabilities: enabled ? ['resumable-upload'] : [],
          namespaceAllowedCapabilities: { [namespaceId]: enabled ? ['resumable-upload'] : [] },
        }),
      );
      builder.overrideProvider(UPLOAD_SESSION_POLICY).useValue(policy());
    }
    const moduleRef = await builder.compile();
    const next = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(next);
    await next.init();
    return next;
  }

  function url(path = ''): string {
    return `/api/v2/namespaces/${namespaceId}/fs/upload-sessions${path}`;
  }

  function create(
    key: string,
    body = { path: '/hidden.bin', sizeBytes: '4', mimeType: 'application/octet-stream', ifAbsent: true },
  ) {
    return request(app.getHttpServer())
      .post(url())
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'integration')
      .set('Idempotency-Key', key)
      .send(body);
  }

  beforeAll(async () => {
    [postgres, s3Container] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      startS3Container(),
    ]);
    process.env.STORIX_DB_HOST = postgres.getHost();
    process.env.STORIX_DB_PORT = String(postgres.getPort());
    process.env.STORIX_DB_USERNAME = postgres.getUsername();
    process.env.STORIX_DB_PASSWORD = postgres.getPassword();
    process.env.STORIX_DB_NAME = postgres.getDatabase();
    process.env.STORIX_STORAGE_ENDPOINT = s3Container.getHost();
    process.env.STORIX_STORAGE_PORT = String(s3Container.getPort());
    process.env.STORIX_STORAGE_USE_SSL = 'false';
    process.env.STORIX_STORAGE_ACCESS_KEY = s3Container.getUsername();
    process.env.STORIX_STORAGE_SECRET_KEY = s3Container.getPassword();
    process.env.STORIX_STORAGE_BUCKET = 'storix-upload-lifecycle';
    process.env.STORIX_ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
    process.env.STORIX_API_KEY = API_KEY;
    process.env.STORIX_ORPHAN_GRACE_PERIOD = '1';
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    delete process.env.STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH;

    const client = createTestS3Client(s3Container);
    await createTestBucket(client, process.env.STORIX_STORAGE_BUCKET);
    migrations = new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity],
      migrations: ALL_MIGRATIONS,
    });
    await migrations.initialize();
    await migrations.runMigrations();
    app = await bootstrap(false);
    const created = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', 'upload-lifecycle-namespace')
      .send({ name: 'upload-lifecycle' })
      .expect(201);
    namespaceId = created.body.id as string;
    await app.close();
    app = await bootstrap(true);
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (migrations?.isInitialized) await migrations.destroy();
    await Promise.all([postgres?.stop(), s3Container?.stop()]);
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });

  it('replays a creation, recovers status after restart, and keeps incomplete content invisible', async () => {
    const key = randomUUID();
    const first = await create(key).expect(201);
    const id = first.body.sessionId as string;
    const replay = await create(key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    expect(
      await app
        .get(VfsUploadSessionRepository)
        .renewSession(namespaceId, id, new Date(Date.now() + 2000), 60),
    ).toBe(true);
    expect((await create(key).expect(201)).body).toEqual(first.body);
    const changed = await create(key, {
      path: '/different.bin',
      sizeBytes: '4',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    }).expect(409);
    expect(changed.body.code).toBe('MUTATION_KEY_REUSED');
    expect(
      (
        await request(app.getHttpServer())
          .get(url('/not-a-uuid'))
          .set('Authorization', `Bearer ${API_KEY}`)
          .expect(404)
      ).body.code,
    ).toBe('VFS_UPLOAD_SESSION_NOT_FOUND');
    await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path: '/hidden.bin' })
      .expect(404);
    await app.close();
    app = await bootstrap(false);
    const status = await request(app.getHttpServer())
      .get(url(`/${id}`))
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(status.body).toMatchObject({ sessionId: id, state: 'OPEN', path: '/hidden.bin', parts: [] });
    expect((await create(key).expect(201)).body).toEqual(first.body);
    await create(randomUUID()).expect(409);
  });

  it('cancellation keeps usage until a failed staging delete is retried; orphan grace protects fresh objects', async () => {
    await app.close();
    app = await bootstrap(true);
    const key = randomUUID();
    const created = await create(key, {
      path: '/cleanup.bin',
      sizeBytes: '4',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    }).expect(201);
    const id = created.body.sessionId as string;
    const repo = app.get(VfsUploadSessionRepository);
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const stagingKey = `upload-staging/${randomUUID()}`;
    const caps = { global: policy().global, namespace: policy().namespaces[namespaceId] };
    expect((await repo.reservePart(id, 0, '4', stagingKey, caps)).kind).toBe('reserved');
    await storage.put(stagingKey, Readable.from(Buffer.from('data')));
    expect(await repo.commitPart(id, 0, '0'.repeat(64), null)).toBe(true);
    const orphanKey = `upload-staging/${randomUUID()}`;
    await storage.put(orphanKey, Readable.from(Buffer.from('orphan')));
    const cancelled = await request(app.getHttpServer())
      .delete(url(`/${id}`))
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(cancelled.body.state).toBe('CANCELLED');
    expect(
      (
        await create(key, {
          path: '/cleanup.bin',
          sizeBytes: '4',
          mimeType: 'application/octet-stream',
          ifAbsent: true,
        }).expect(201)
      ).body,
    ).toEqual(created.body);
    const originalDelete = storage.delete.bind(storage);
    const deleteSpy = jest
      .spyOn(storage, 'delete')
      .mockImplementationOnce(async () => {
        throw new Error('storage unavailable');
      })
      .mockImplementation(originalDelete);
    const gc = app.get(GcJob);
    await gc.run();
    expect((await repo.findForStatus(namespaceId, id))?.session.state).toBe('CANCELLED');
    expect((await repo.findKnownStagingKeys([stagingKey])).has(stagingKey)).toBe(true);
    expect((await storage.get(orphanKey)).readable).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await gc.run();
    expect((await repo.findKnownStagingKeys([stagingKey])).has(stagingKey)).toBe(false);
    expect((await repo.findKnownStagingKeys([orphanKey])).has(orphanKey)).toBe(false);
    await expect(storage.get(orphanKey)).rejects.toThrow();
    deleteSpy.mockRestore();
  });

  it('expires idle sessions, recovers stale finalization leases, and prunes terminal records after retention', async () => {
    const expired = await create(randomUUID(), {
      path: '/expires.bin',
      sizeBytes: '0',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    }).expect(201);
    const expiredId = expired.body.sessionId as string;
    await migrations.query(
      `UPDATE vfs_upload_session SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expiredId],
    );
    const repo = app.get(VfsUploadSessionRepository);
    expect(await repo.renewSession(namespaceId, expiredId, new Date(), 60)).toBe(false);
    const firstGc = await app.get(GcJob).run();
    expect(firstGc.expiredUploadSessions).toBe(1);
    expect((await repo.findForStatus(namespaceId, expiredId))?.session.state).toBe('EXPIRED');

    const finalizing = await create(randomUUID(), {
      path: '/lease.bin',
      sizeBytes: '0',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    }).expect(201);
    const finalizingId = finalizing.body.sessionId as string;
    expect((await repo.claimFinalize(namespaceId, finalizingId, 60_000)).kind).toBe('claimed');
    await migrations.query(
      `UPDATE vfs_upload_session SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [finalizingId],
    );
    const secondGc = await app.get(GcJob).run();
    expect(secondGc.recoveredUploadSessions).toBe(1);
    expect((await repo.findForStatus(namespaceId, finalizingId))?.session.state).toBe('OPEN');

    const maxLifetime = await create(randomUUID(), {
      path: '/max-lifetime.bin',
      sizeBytes: '0',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    }).expect(201);
    const maxLifetimeId = maxLifetime.body.sessionId as string;
    await migrations.query(
      `UPDATE vfs_upload_session SET max_expires_at = now() - interval '1 second' WHERE id = $1`,
      [maxLifetimeId],
    );
    await migrations.query(
      `UPDATE vfs_upload_session SET terminal_at = now() - interval '31 days' WHERE id = $1`,
      [expiredId],
    );
    const thirdGc = await app.get(GcJob).run();
    expect(thirdGc.expiredUploadSessions).toBe(1);
    expect((await repo.findForStatus(namespaceId, maxLifetimeId))?.session.state).toBe('EXPIRED');
    expect(thirdGc.prunedUploadSessions).toBe(1);
    await request(app.getHttpServer())
      .get(url(`/${expiredId}`))
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(404);
  });
});
