import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource, IsNull } from 'typeorm';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { MASTER_KEY } from '../../src/encryption/encryption.constants.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';

type StartedApp = { app: INestApplication; port: number };

describe('공유 PostgreSQL의 다중 API 인스턴스 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let migrationDataSource: DataSource;
  let first: StartedApp;
  let second: StartedApp;

  async function bootstrap(): Promise<StartedApp> {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule, VfsModule],
    })
      .overrideProvider(MASTER_KEY)
      .useValue(Buffer.from('ab'.repeat(32), 'hex'))
      .compile();

    const app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();
    await app.listen(0);
    return { app, port: (app.getHttpServer().address() as { port: number }).port };
  }

  beforeAll(async () => {
    postgresContainer = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    minioContainer = await new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start();

    process.env.STORIX_DB_HOST = postgresContainer.getHost();
    process.env.STORIX_DB_PORT = String(postgresContainer.getPort());
    process.env.STORIX_DB_USERNAME = postgresContainer.getUsername();
    process.env.STORIX_DB_PASSWORD = postgresContainer.getPassword();
    process.env.STORIX_DB_NAME = postgresContainer.getDatabase();
    process.env.STORIX_STORAGE_ENDPOINT = minioContainer.getHost();
    process.env.STORIX_STORAGE_PORT = String(minioContainer.getPort());
    process.env.STORIX_STORAGE_USE_SSL = 'false';
    process.env.STORIX_STORAGE_ACCESS_KEY = minioContainer.getUsername();
    process.env.STORIX_STORAGE_SECRET_KEY = minioContainer.getPassword();
    process.env.STORIX_STORAGE_BUCKET = 'storix-multi-instance-test';

    const minioClient = new MinioClient({
      endPoint: minioContainer.getHost(),
      port: minioContainer.getPort(),
      useSSL: false,
      accessKey: minioContainer.getUsername(),
      secretKey: minioContainer.getPassword(),
    });
    await minioClient.makeBucket(process.env.STORIX_STORAGE_BUCKET);

    migrationDataSource = new DataSource({
      type: 'postgres',
      url: postgresContainer.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, VfsMutationReceiptEntity],
      migrations: ALL_MIGRATIONS,
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();

    first = await bootstrap();
    second = await bootstrap();
  }, 180000);

  afterAll(async () => {
    await Promise.all([first?.app.close(), second?.app.close()]);
    await migrationDataSource?.destroy();
    await postgresContainer?.stop();
    await minioContainer?.stop();
  });

  async function createNamespace(name: string): Promise<string> {
    const response = await request(`http://127.0.0.1:${first.port}`)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    return response.body.id as string;
  }

  function mutation(app: StartedApp, namespaceId: string, key: string, body: Record<string, unknown>) {
    return request(`http://127.0.0.1:${app.port}`)
      .post(`/api/v2/namespaces/${namespaceId}/fs/mutations`)
      .set('Idempotency-Key', key)
      .set('X-Mutation-Scope', 'multi-instance-test')
      .send(body);
  }

  function conditionalUpload(
    app: StartedApp,
    namespaceId: string,
    key: string,
    revision: string,
    bytes: Buffer,
  ) {
    return request(`http://127.0.0.1:${app.port}`)
      .post(`/api/v2/namespaces/${namespaceId}/fs/content/conditional`)
      .query({ path: '/target' })
      .set('Idempotency-Key', key)
      .set('X-Mutation-Scope', 'multi-instance-test')
      .set('X-If-Revision', revision)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
  }

  async function waitForReceipt(namespaceId: string, key: string, state: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await migrationDataSource.query(
        'SELECT state FROM vfs_mutation_receipt WHERE namespace_id = $1 AND scope = $2 AND idempotency_key = $3',
        [namespaceId, 'multi-instance-test', key],
      );
      if (rows[0]?.state === state) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`expected mutation receipt state ${state}`);
  }

  async function waitForBlockedRequests(holderPid: number, count: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await migrationDataSource.query(
        'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0',
        [holderPid],
      );
      if (new Set(rows.map((row: { pid: number }) => row.pid)).size >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`expected ${count} distinct PostgreSQL lock waiters`);
  }

  it('동일 key 요청을 다른 인스턴스가 진행 중 거부한 뒤 완료 receipt로 재생한다', async () => {
    const namespaceId = await createNamespace(`same-key-${randomUUID()}`);
    const key = randomUUID();
    const body = { kind: 'mkdir', path: '/once', ifAbsent: true };
    const holder = migrationDataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query('SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE', [
      namespaceId,
    ]);

    let firstRequest: ReturnType<typeof mutation> | undefined;
    try {
      firstRequest = mutation(first, namespaceId, key, body);
      const firstResponse = firstRequest.then((response) => response);
      await waitForReceipt(namespaceId, key, 'RESERVED');

      const concurrent = await mutation(second, namespaceId, key, body);
      expect(concurrent.status).toBe(409);
      expect(concurrent.body.code).toBe('MUTATION_IN_PROGRESS');

      await holder.commitTransaction();
      const applied = await firstResponse;
      expect(applied.status).toBe(201);

      const replay = await mutation(second, namespaceId, key, body);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(applied.body);
      expect(replay.headers['x-request-id']).toBe(applied.headers['x-request-id']);
      expect(
        (
          await request(`http://127.0.0.1:${second.port}`)
            .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
            .query({ path: '/once' })
            .expect(200)
        ).body.path,
      ).toBe('/once');
      expect(
        await migrationDataSource.getRepository(VfsMutationReceiptEntity).findBy({
          namespaceId,
          scope: 'multi-instance-test',
          idempotencyKey: key,
        }),
      ).toMatchObject([{ state: 'COMPLETE', responseStatus: 201 }]);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
      if (firstRequest) await firstRequest;
    }
  });

  it('두 인스턴스의 동일 sourceRevision 조건부 교체에서 하나만 성공한다', async () => {
    const namespaceId = await createNamespace(`conditional-race-${randomUUID()}`);
    const base = `/api/v2/namespaces/${namespaceId}/fs`;
    await request(`http://127.0.0.1:${first.port}`)
      .post(`${base}/content`)
      .query({ path: '/target' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('initial'))
      .expect(201);
    const target = (
      await request(`http://127.0.0.1:${second.port}`)
        .get(`${base}/stat`)
        .query({ path: '/target' })
        .expect(200)
    ).body as { revision: string };
    const rootBefore = await migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId, parentId: IsNull() });
    const keys = [randomUUID(), randomUUID()];
    const payloads = [Buffer.from('first winner'), Buffer.from('second winner')];
    const holder = migrationDataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
    await holder.query('SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE', [
      namespaceId,
    ]);
    const pending = [
      conditionalUpload(first, namespaceId, keys[0], target.revision, payloads[0]).then(
        (response) => response,
      ),
      conditionalUpload(second, namespaceId, keys[1], target.revision, payloads[1]).then(
        (response) => response,
      ),
    ];

    try {
      await waitForReceipt(namespaceId, keys[0], 'RESERVED');
      await waitForReceipt(namespaceId, keys[1], 'RESERVED');
      await waitForBlockedRequests(Number(holderPid), 2);
      await holder.commitTransaction();
      const responses = await Promise.all(pending);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
      expect(responses.find((response) => response.status === 412)?.body.code).toBe(
        'VFS_PRECONDITION_FAILED',
      );
      const rootAfter = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });
      expect(rootAfter.version).toBe(rootBefore.version + 1);
      const winner = responses.findIndex((response) => response.status === 200);
      expect(
        (
          await request(`http://127.0.0.1:${second.port}`)
            .get(`${base}/content`)
            .query({ path: '/target' })
            .expect(200)
        ).body,
      ).toEqual(payloads[winner]);
      await request(`http://127.0.0.1:${second.port}`)
        .get(`${base}/stat`)
        .query({ path: '/target' })
        .expect(200);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
      await Promise.all(pending);
    }
  });
});
