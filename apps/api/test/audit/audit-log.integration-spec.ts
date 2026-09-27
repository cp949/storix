import { randomUUID } from 'node:crypto';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';
import { ApiKeyGuard } from '../../src/auth/api-key.guard.js';
import { AuthModule } from '../../src/auth/auth.module.js';
import { VALID_API_KEYS } from '../../src/auth/auth.constants.js';
import { Public } from '../../src/auth/public.decorator.js';
import { RequestContextMiddleware } from '../../src/common/request-context.middleware.js';
import { HealthModule } from '../../src/health/health.module.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { AuditLogEntity } from '../../src/persistence/entities/audit-log.entity.js';
import { AuditLogRepository } from '../../src/persistence/audit-log.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { AuditModule } from '../../src/audit/audit.module.js';

@Controller('audit-auth-probe')
class AuditAuthProbeController {
  @Get('protected') protectedRoute() {
    return { ok: true };
  }
  @Get('protected/:id') protectedParamRoute() {
    return { ok: true };
  }
  @Public() @Get('public') publicRoute() {
    return { ok: true };
  }
}

@Module({
  controllers: [AuditAuthProbeController],
  providers: [
    { provide: VALID_API_KEYS, useValue: ['valid-test-key'] },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
class AuditAuthProbeModule {}

describe('감사 로그 end-to-end', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let migrationDataSource: DataSource;
  let minioClient: MinioClient;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;

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
    process.env.STORIX_STORAGE_BUCKET = 'storix-audit-test';
    process.env.STORIX_MAX_FILE_SIZE_BYTES = String(1024 * 1024 * 1024);
    process.env.STORIX_MAX_SYNC_DELETE_NODES = '1000';
    process.env.STORIX_MAX_SYNC_COPY_NODES = '1000';

    minioClient = new MinioClient({
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
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS,
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        AuditModule,
        HealthModule,
        NamespaceModule,
        VfsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.listen(0, '127.0.0.1');
    httpServer = app.getHttpServer();
  }, 180000);

  afterAll(async () => {
    await app.close();
    await migrationDataSource.destroy();
    await postgresContainer.stop();
    await minioContainer.stop();
  });

  // AuditLogInterceptor는 응답의 'close' 이벤트에서 기록을 시작하고 완료를 기다리지 않는
  // best-effort 비동기 기록이라(audit-log.interceptor.ts, 단위 테스트에도 명시된 설계),
  // supertest가 응답을 받은 직후 곧바로 조회하면 INSERT가 아직 커밋되지 않았을 수 있다.
  // 짧은 간격으로 재시도해 이 최종 일관성 지연을 흡수한다.
  async function findAuditLogByRequestId(requestId: string) {
    const maxAttempts = 20;
    const intervalMs = 50;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const rows = await migrationDataSource.query('SELECT * FROM audit_log WHERE request_id = $1', [
        requestId,
      ]);
      if (rows[0]) {
        return rows[0] as {
          request_id: string;
          namespace_id: string | null;
          operation: string;
          path: string | null;
          detail: unknown;
          caller: string | null;
          snapshot_id: string | null;
          trash_id: string | null;
          status: number;
        };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return undefined;
  }

  it('namespace 생성 요청을 감사 로그에 기록한다', async () => {
    const name = `audit-e2e-${randomUUID()}`;
    const response = await request(httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);

    const row = await findAuditLogByRequestId(response.headers['x-request-id'] as string);

    expect(row).toMatchObject({
      operation: 'NamespaceController.create',
      namespace_id: null,
      status: 201,
      detail: { name },
    });
  });

  it('X-Caller-Id 헤더를 caller로 기록하고, 없으면 NULL로 기록한다', async () => {
    const name = `audit-caller-${randomUUID()}`;
    const createResponse = await request(httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    const namespaceId = createResponse.body.id as string;

    const withCaller = await request(httpServer)
      .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
      .set('X-Caller-Id', 'billing-service')
      .send({ path: '/dir-a' })
      .expect(201);
    const withoutCaller = await request(httpServer)
      .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
      .send({ path: '/dir-b' })
      .expect(201);

    const rowWithCaller = await findAuditLogByRequestId(withCaller.headers['x-request-id'] as string);
    const rowWithoutCaller = await findAuditLogByRequestId(withoutCaller.headers['x-request-id'] as string);

    expect(rowWithCaller).toMatchObject({
      operation: 'FsController.mkdir',
      namespace_id: namespaceId,
      path: '/dir-a',
      caller: 'billing-service',
      status: 201,
    });
    expect(rowWithoutCaller?.caller).toBeNull();
  });

  it('mv 요청은 source/destination을 detail에 기록한다', async () => {
    const name = `audit-mv-${randomUUID()}`;
    const createResponse = await request(httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    const namespaceId = createResponse.body.id as string;
    await request(httpServer)
      .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
      .send({ path: '/from.txt' })
      .expect(201);

    const mvResponse = await request(httpServer)
      .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
      .send({ source: '/from.txt', destination: '/to.txt' })
      .expect(200);

    const row = await findAuditLogByRequestId(mvResponse.headers['x-request-id'] as string);

    expect(row).toMatchObject({
      operation: 'FsController.mv',
      detail: { source: '/from.txt', destination: '/to.txt' },
    });
  });

  it('snapshot 생성과 개별 ID 조회는 ID를 기록하고 목록에는 단일 ID를 기록하지 않는다', async () => {
    const name = `audit-snapshot-${randomUUID()}`;
    const ns = await request(httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    const base = `/api/v2/namespaces/${ns.body.id}/fs`;
    await request(httpServer)
      .post(`${base}/content`)
      .query({ path: '/audit.txt' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('secret-body'))
      .expect(201);
    const created = await request(httpServer)
      .post(`${base}/snapshots`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Mutation-Scope', 'audit-test')
      .send({ kind: 'file', path: '/audit.txt' })
      .expect(201);
    const snapshotId = created.body.snapshotId as string;
    const get = await request(httpServer).get(`${base}/snapshots/${snapshotId}`).expect(200);
    const content = await request(httpServer).get(`${base}/snapshots/${snapshotId}/content`).expect(200);
    const tree = await request(httpServer)
      .post(`${base}/snapshots`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Mutation-Scope', 'audit-test')
      .send({ kind: 'tree', path: '/' })
      .expect(201);
    const treeId = tree.body.snapshotId as string;
    const entries = await request(httpServer).get(`${base}/snapshots/${treeId}/entries`).expect(200);
    const treeContent = await request(httpServer)
      .get(`${base}/snapshots/${treeId}/content`)
      .query({ path: 'audit.txt' })
      .expect(200);
    const restored = await request(httpServer)
      .post(`${base}/snapshots/${snapshotId}/restore`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Mutation-Scope', 'audit-test')
      .send({ path: '/restored.txt', ifAbsent: true })
      .expect(201);
    const list = await request(httpServer)
      .get(`${base}/snapshots`)
      .query({
        rootNodeId: (await request(httpServer).get(`${base}/stat`).query({ path: '/audit.txt' })).body.id,
      })
      .expect(200);
    const deleted = await request(httpServer)
      .post(`${base}/snapshots/${snapshotId}/delete`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Mutation-Scope', 'audit-test')
      .send({})
      .expect(200);

    for (const [response, expectedId] of [
      [created, snapshotId],
      [get, snapshotId],
      [content, snapshotId],
      [entries, treeId],
      [treeContent, treeId],
      [restored, snapshotId],
      [deleted, snapshotId],
    ] as const) {
      const row = await findAuditLogByRequestId(response.headers['x-request-id'] as string);
      expect(row?.snapshot_id).toBe(expectedId);
      expect(JSON.stringify(row)).not.toContain('secret-body');
    }
    const listRow = await findAuditLogByRequestId(list.headers['x-request-id'] as string);
    expect(listRow?.snapshot_id).toBeNull();
  });

  it('삭제·복원·purge는 같은 trash ID를 기록하고 목록은 null을 기록한다', async () => {
    const name = `audit-trash-${randomUUID()}`;
    const ns = await request(httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    process.env.STORIX_ADMIN_API_KEY = 'trash-admin-test-key';
    await request(httpServer)
      .patch(`/api/v2/admin/namespaces/${ns.body.id}/trash`)
      .set('Authorization', 'Bearer trash-admin-test-key')
      .set('Idempotency-Key', randomUUID())
      .send({ enabled: true })
      .expect(200);
    const base = `/api/v2/namespaces/${ns.body.id}/fs`;
    await request(httpServer).post(`${base}/touch`).send({ path: '/first' }).expect(201);
    const deleted = await request(httpServer).post(`${base}/rm`).query({ path: '/first' }).expect(204);
    const trashId = deleted.headers['x-trash-id'] as string;
    const listed = await request(httpServer).get(`${base}/trash`).expect(200);
    const restored = await request(httpServer)
      .post(`${base}/trash/${trashId}/restore`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Mutation-Scope', 'audit-test')
      .send({})
      .expect(200);
    await request(httpServer).post(`${base}/touch`).send({ path: '/second' }).expect(201);
    const second = await request(httpServer).post(`${base}/rm`).query({ path: '/second' }).expect(204);
    const secondId = second.headers['x-trash-id'] as string;
    process.env.STORIX_ADMIN_API_KEY = 'audit-trash-admin-key';
    try {
      const purged = await request(httpServer)
        .post(`${base}/trash/${secondId}/purge`)
        .set('Authorization', 'Bearer audit-trash-admin-key')
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'audit-test')
        .send({})
        .expect(200);
      for (const [response, id] of [
        [deleted, trashId],
        [restored, trashId],
        [second, secondId],
        [purged, secondId],
      ] as const) {
        expect((await findAuditLogByRequestId(response.headers['x-request-id'] as string))?.trash_id).toBe(
          id,
        );
      }
      expect((await findAuditLogByRequestId(listed.headers['x-request-id'] as string))?.trash_id).toBeNull();
    } finally {
      delete process.env.STORIX_ADMIN_API_KEY;
    }
  });

  it('휴지통 OFF의 영구 삭제 감사 row는 trash_id가 null이다', async () => {
    const name = `audit-trash-off-${randomUUID()}`;
    const created = await request(httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    const base = `/api/v2/namespaces/${created.body.id}/fs`;
    await request(httpServer).post(`${base}/touch`).send({ path: '/permanent' }).expect(201);
    const deleted = await request(httpServer).post(`${base}/rm`).query({ path: '/permanent' }).expect(204);
    const row = await findAuditLogByRequestId(deleted.headers['x-request-id'] as string);
    expect(row?.trash_id).toBeNull();
  });

  it('누락·오류 API key를 HTTP 요청 ID로 조회하고 자기신고 주체와 비밀은 저장하지 않는다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuditAuthProbeModule] }).compile();
    const authApp = moduleRef.createNestApplication();
    const requestContext = new RequestContextMiddleware();
    authApp.use((req: Request, res: Response, next: NextFunction) => requestContext.use(req, res, next));
    authApp.useGlobalFilters(new DomainErrorFilter(undefined, new AuditLogRepository(migrationDataSource)));
    await authApp.init();
    const server = authApp.getHttpServer();
    try {
      const missingId = `audit-missing-${randomUUID()}`;
      const wrongId = `audit-wrong-${randomUUID()}`;
      const longPathId = `audit-long-${randomUUID()}`;
      const longPath = `/audit-auth-probe/protected/${'x'.repeat(150)}`;
      const missing = await request(server)
        .get('/audit-auth-probe/protected')
        .query({ secret: 'private-body' })
        .set('X-Request-Id', missingId)
        .set('X-Caller-Id', 'self-claimed')
        .expect(401);
      const wrong = await request(server)
        .get('/audit-auth-probe/protected')
        .set('Authorization', 'Bearer raw-secret-key')
        .set('X-Request-Id', wrongId)
        .expect(401);
      await request(server).get(longPath).set('X-Request-Id', longPathId).expect(401);
      await request(server).get('/audit-auth-probe/public').expect(200);
      expect(missing.body).toMatchObject({ code: 'UNAUTHORIZED', requestId: missingId });
      expect(wrong.body).toMatchObject({ code: 'UNAUTHORIZED', requestId: wrongId });
      for (const [requestId, operation, path] of [
        [missingId, 'GET /audit-auth-probe/protected', '/audit-auth-probe/protected'],
        [wrongId, 'GET /audit-auth-probe/protected', '/audit-auth-probe/protected'],
        [longPathId, `GET ${longPath}`.slice(0, 128), longPath],
      ] as const) {
        const row = await findAuditLogByRequestId(requestId);
        expect(row).toMatchObject({
          request_id: requestId,
          namespace_id: null,
          snapshot_id: null,
          operation,
          path,
          caller: null,
          status: 401,
        });
        expect(JSON.stringify(row)).not.toContain('raw-secret-key');
        expect(JSON.stringify(row)).not.toContain('private-body');
      }
    } finally {
      await authApp.close();
    }
  });

  it('실제 컨트롤러의 필터도 API key 거부를 감사 기록한다', async () => {
    // 운영 경로의 VFS·namespace 컨트롤러는 전역 필터가 아니라 @UseFilters(DomainErrorFilter)로
    // DI 생성된 필터가 가드 예외를 처리한다. 이 인스턴스에 감사 저장소가 주입되는지 확인한다.
    const previous = process.env.STORIX_API_KEY;
    process.env.STORIX_API_KEY = 'audit-real-route-key';
    let securedApp: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true }),
          AuthModule,
          AuditModule,
          NamespaceModule,
          VfsModule,
        ],
      }).compile();
      securedApp = moduleRef.createNestApplication({ bodyParser: false });
      configureBodyParsers(securedApp);
      await securedApp.init();
      const namespaceId = randomUUID();
      const snapshotsPath = `/api/v2/namespaces/${namespaceId}/fs/snapshots`;
      const namespacePath = `/api/v2/namespaces/${namespaceId}`;
      const vfsRequestId = `audit-real-vfs-${randomUUID()}`;
      const namespaceRequestId = `audit-real-ns-${randomUUID()}`;
      await request(securedApp.getHttpServer())
        .get(snapshotsPath)
        .set('X-Request-Id', vfsRequestId)
        .expect(401);
      await request(securedApp.getHttpServer())
        .get(namespacePath)
        .set('Authorization', 'Bearer raw-secret-key')
        .set('X-Request-Id', namespaceRequestId)
        .expect(401);

      for (const [requestId, path] of [
        [vfsRequestId, snapshotsPath],
        [namespaceRequestId, namespacePath],
      ] as const) {
        const row = await findAuditLogByRequestId(requestId);
        expect(row).toMatchObject({
          operation: `GET ${path}`,
          path,
          namespace_id: null,
          caller: null,
          status: 401,
        });
        expect(JSON.stringify(row)).not.toContain('raw-secret-key');
      }
    } finally {
      await securedApp?.close();
      if (previous === undefined) delete process.env.STORIX_API_KEY;
      else process.env.STORIX_API_KEY = previous;
    }
  });

  it('admin quota 변경 성공도 감사 기록한다', async () => {
    const previous = process.env.STORIX_ADMIN_API_KEY;
    process.env.STORIX_ADMIN_API_KEY = 'audit-admin-key';
    try {
      const name = `audit-quota-${randomUUID()}`;
      const ns = await request(httpServer)
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', `ns-${name}`)
        .send({ name })
        .expect(201);
      const response = await request(httpServer)
        .patch(`/api/v2/admin/namespaces/${ns.body.id}/quota`)
        .set('Authorization', 'Bearer audit-admin-key')
        .set('Idempotency-Key', randomUUID())
        .set('X-Caller-Id', 'ops-console')
        .send({ maxTotalLogicalBytes: '2048' })
        .expect(200);

      const row = await findAuditLogByRequestId(response.headers['x-request-id'] as string);
      expect(row).toMatchObject({
        namespace_id: ns.body.id,
        operation: 'NamespaceQuotaController.update',
        caller: 'ops-console',
        status: 200,
      });
      expect(JSON.stringify(row)).not.toContain('audit-admin-key');
    } finally {
      if (previous === undefined) delete process.env.STORIX_ADMIN_API_KEY;
      else process.env.STORIX_ADMIN_API_KEY = previous;
    }
  });

  it('/health/live 요청은 감사 로그에 남지 않는다', async () => {
    const response = await request(httpServer).get('/health/live').expect(200);

    const row = await findAuditLogByRequestId(response.headers['x-request-id'] as string);

    expect(row).toBeUndefined();
  });
});
