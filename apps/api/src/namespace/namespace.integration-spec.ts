import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceCreationReceiptWriter } from '../persistence/namespace-creation-receipt.writer.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { NamespaceModule } from './namespace.module.js';

type RowCount = { count: string };

describe('Namespace HTTP contract', () => {
  let container: StartedPostgreSqlContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();

    process.env.STORIX_DB_HOST = container.getHost();
    process.env.STORIX_DB_PORT = String(container.getPort());
    process.env.STORIX_DB_USERNAME = container.getUsername();
    process.env.STORIX_DB_PASSWORD = container.getPassword();
    process.env.STORIX_DB_NAME = container.getDatabase();
    process.env.STORIX_ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
    process.env.STORIX_ADMIN_API_KEY = 'quota-admin-secret';

    migrationDataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS,
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 120000);

  afterAll(async () => {
    await app.close();
    await migrationDataSource.destroy();
    await container.stop();
  });

  async function namespaceCounts(name: string) {
    const namespaces = (await migrationDataSource.query(
      'SELECT COUNT(*)::text AS count FROM namespace WHERE name = $1',
      [name],
    )) as RowCount[];
    const roots = (await migrationDataSource.query(
      `SELECT COUNT(*)::text AS count FROM vfs_node n
       INNER JOIN namespace ns ON ns.id = n.namespace_id
       WHERE ns.name = $1 AND n.parent_id IS NULL AND n.type = 'DIRECTORY' AND n.name = ''`,
      [name],
    )) as RowCount[];
    return { namespaces: Number(namespaces[0].count), roots: Number(roots[0].count) };
  }

  async function receiptCount(key: string): Promise<number> {
    const rows = (await migrationDataSource.query('SELECT COUNT(*)::text AS count FROM idempotency_key WHERE key = $1', [
      key,
    ])) as RowCount[];
    return Number(rows[0].count);
  }

  it('동일 key·동일 body 동시 요청은 최초 201 body와 namespace/root/receipt 하나를 반환한다', async () => {
    const key = 'namespace-concurrent-same-body';
    const body = { name: 'namespace-concurrent-same-body' };
    const responses = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer()).post('/api/v2/namespaces').set('Idempotency-Key', key).send(body),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(responses[1].body).toEqual(responses[0].body);
    expect(await namespaceCounts(body.name)).toEqual({ namespaces: 1, roots: 1 });
    expect(await receiptCount(key)).toBe(1);
  });

  it('동일 key·상이 body 동시 요청은 하나의 201과 IDEMPOTENCY_KEY_REUSED 422를 반환한다', async () => {
    const key = 'namespace-concurrent-different-body';
    const bodies = [{ name: 'namespace-concurrent-different-body-a' }, { name: 'namespace-concurrent-different-body-b' }];
    const responses = await Promise.all(
      bodies.map((body) => request(app.getHttpServer()).post('/api/v2/namespaces').set('Idempotency-Key', key).send(body)),
    );

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 422]);
    expect(responses.find(({ status }) => status === 422)?.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const namespaceNames = await Promise.all(bodies.map(({ name }) => namespaceCounts(name)));
    expect(namespaceNames.reduce((count, rows) => count + rows.namespaces, 0)).toBe(1);
    expect(namespaceNames.reduce((count, rows) => count + rows.roots, 0)).toBe(1);
    expect(await receiptCount(key)).toBe(1);
  });

  it('receipt 저장 실패는 namespace/root도 롤백하고 앱 재시작 뒤 같은 key를 성공시킨다', async () => {
    const key = 'namespace-receipt-failure-restart';
    const body = { name: 'namespace-receipt-failure-restart' };
    const receiptWriter = app.get(NamespaceCreationReceiptWriter);
    jest.spyOn(receiptWriter, 'save').mockRejectedValueOnce(new Error('injected receipt write failure'));

    const failed = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', key)
      .send(body);
    const beforeRestart = await namespaceCounts(body.name);
    const receiptBeforeRestart = await receiptCount(key);

    await app.close();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const retry = await request(app.getHttpServer()).post('/api/v2/namespaces').set('Idempotency-Key', key).send(body);
    expect({
      failedStatus: failed.status,
      beforeRestart,
      receiptBeforeRestart,
      retryStatus: retry.status,
      retryName: retry.body.name,
      afterRestart: await namespaceCounts(body.name),
      receiptAfterRestart: await receiptCount(key),
    }).toEqual({
      failedStatus: 500,
      beforeRestart: { namespaces: 0, roots: 0 },
      receiptBeforeRestart: 0,
      retryStatus: 201,
      retryName: body.name,
      afterRestart: { namespaces: 1, roots: 1 },
      receiptAfterRestart: 1,
    });
  });

  it('Idempotency-Key 헤더가 없으면 400을 반환한다', async () => {
    await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .send({ name: 'no-key-ns' })
      .expect(400);
  });

  it('name만으로 namespace를 생성하면 201과 함께 NONE/ACTIVE 상태를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-1')
      .send({ name: 'acme' })
      .expect(201);

    expect(response.body).toMatchObject({
      name: 'acme',
      encryptionPolicy: 'NONE',
      accessPolicy: 'PRIVATE',
      status: 'ACTIVE',
    });
    expect(response.body.id).toEqual(expect.any(String));
    expect(response.body.quota).toEqual({ limitBytes: '53687091200', usedBytes: '0' });
  });

  it('namespace 생성 시 더 낮은 logical quota를 지정하고 응답·조회에 노출한다', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-quota')
      .send({ name: 'quota-create', maxTotalLogicalBytes: '1024' })
      .expect(201);

    expect(created.body.quota).toEqual({ limitBytes: '1024', usedBytes: '0' });
    const fetched = await request(app.getHttpServer()).get(`/api/v2/namespaces/${created.body.id}`).expect(200);
    expect(fetched.body.quota).toEqual({ limitBytes: '1024', usedBytes: '0' });
  });

  it('namespace 조회는 유효 파일 한도와 live·snapshot 논리 사용량을 문자열로 반환한다', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-file-limit-details')
      .send({ name: 'file-limit-details', maxTotalLogicalBytes: '1024' })
      .expect(201);
    await migrationDataSource.getRepository(NamespaceEntity).update(created.body.id, {
      maxFileSizeBytes: '512',
      liveFileByteCount: '12',
      retainedSnapshotByteCount: '5',
    });

    const fetched = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${created.body.id}`)
      .expect(200);
    expect(fetched.body.limits).toEqual({ maxFileSizeBytes: '512' });
    expect(fetched.body.quota).toEqual({ limitBytes: '1024', usedBytes: '17' });
  });

  it('namespace 조회는 인증 누락과 잘못된 키를 거부한다', async () => {
    const previous = process.env.STORIX_API_KEY;
    process.env.STORIX_API_KEY = 'namespace-details-key';
    let securedApp: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule],
      }).compile();
      securedApp = moduleRef.createNestApplication();
      await securedApp.init();
      const url = '/api/v2/namespaces/11111111-1111-1111-1111-111111111111';
      await request(securedApp.getHttpServer()).get(url).expect(401);
      await request(securedApp.getHttpServer())
        .get(url)
        .set('Authorization', 'Bearer wrong-key')
        .expect(401);
      await request(securedApp.getHttpServer())
        .get(url)
        .set('Authorization', 'Bearer namespace-details-key')
        .expect(404);
    } finally {
      await securedApp?.close();
      if (previous === undefined) delete process.env.STORIX_API_KEY;
      else process.env.STORIX_API_KEY = previous;
    }
  });

  it('quota 관리자 경로는 전용 키를 요구하고 변경 receipt를 재생한다', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-admin-quota')
      .send({ name: 'quota-admin-update' })
      .expect(201);
    const path = `/api/v2/admin/namespaces/${created.body.id}/quota`;

    await request(app.getHttpServer()).patch(path).send({ maxTotalLogicalBytes: '2048' }).expect(401);
    const first = await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', 'Bearer quota-admin-secret')
      .set('Idempotency-Key', 'quota-admin-patch')
      .send({ maxTotalLogicalBytes: '2048' })
      .expect(200);
    expect(first.body.quota.limitBytes).toBe('2048');

    const replay = await request(app.getHttpServer())
      .patch(path)
      .set('Authorization', 'Bearer quota-admin-secret')
      .set('Idempotency-Key', 'quota-admin-patch')
      .send({ maxTotalLogicalBytes: '2048' })
      .expect(200);
    expect(replay.body).toEqual(first.body);
  });

  it('같은 key와 같은 body로 재시도하면 새로 만들지 않고 같은 결과를 재생한다', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-retry')
      .send({ name: 'retry-ns' })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-retry')
      .send({ name: 'retry-ns' })
      .expect(201);

    expect(second.body).toEqual(first.body);
  });

  it('같은 key에 다른 body가 오면 422 IDEMPOTENCY_KEY_REUSED를 반환한다', async () => {
    await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'reused-key')
      .send({ name: 'first-body' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'reused-key')
      .send({ name: 'different-body' })
      .expect(422);

    expect(response.body).toEqual({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it('다른 key로 이미 활성화된 name을 생성하면 409 NAMESPACE_ALREADY_EXISTS를 반환한다', async () => {
    await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'owner-key')
      .send({ name: 'conflict-ns' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'other-key')
      .send({ name: 'conflict-ns' })
      .expect(409);

    expect(response.body).toEqual({
      code: 'NAMESPACE_ALREADY_EXISTS',
      message: expect.any(String),
      requestId: expect.any(String),
    });
    expect(await namespaceCounts('conflict-ns')).toEqual({ namespaces: 1, roots: 1 });
    expect(await receiptCount('owner-key')).toBe(1);
    expect(await receiptCount('other-key')).toBe(1);
  });

  it('같은 key로 409 응답을 재시도해도 재생 응답에 requestId가 포함된다', async () => {
    await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'owner-key-2')
      .send({ name: 'conflict-ns-2' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'retry-key')
      .send({ name: 'conflict-ns-2' })
      .expect(409);

    const replay = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'retry-key')
      .send({ name: 'conflict-ns-2' })
      .expect(409);

    expect(replay.body).toEqual({
      code: 'NAMESPACE_ALREADY_EXISTS',
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it('생성한 namespace를 단건 조회할 수 있다', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'get-one-key')
      .send({ name: 'get-one-ns' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${created.body.id}`)
      .expect(200);

    expect(response.body).toEqual(created.body);
  });

  it('존재하지 않는 id를 단건 조회하면 404를 반환한다', async () => {
    await request(app.getHttpServer())
      .get('/api/v2/namespaces/11111111-1111-1111-1111-111111111111')
      .expect(404);
  });

  it('생성한 namespace가 목록 조회에 포함된다', async () => {
    await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'list-key')
      .send({ name: 'list-ns' })
      .expect(201);

    const response = await request(app.getHttpServer()).get('/api/v2/namespaces').expect(200);

    expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'list-ns' })]));
  });

  it('encryptionPolicy를 ENCRYPTED로 생성할 수 있다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'ns-encrypted-create')
      .send({ name: 'encrypted-ns', encryptionPolicy: 'ENCRYPTED' })
      .expect(201);

    expect(response.body).toMatchObject({ name: 'encrypted-ns', encryptionPolicy: 'ENCRYPTED' });
  });

  it('accessPolicy를 PUBLIC으로 생성할 수 있다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-public')
      .send({ name: 'public-ns', accessPolicy: 'PUBLIC' })
      .expect(201);

    expect(response.body).toMatchObject({ name: 'public-ns', accessPolicy: 'PUBLIC' });
  });

  it('ENCRYPTED와 PUBLIC을 함께 지정하면 400을 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-conflict')
      .send({ name: 'conflict-ns', encryptionPolicy: 'ENCRYPTED', accessPolicy: 'PUBLIC' })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'NAMESPACE_PUBLIC_ENCRYPTION_CONFLICT' });
  });

  it('accessPolicy가 유효하지 않으면 400을 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'create-invalid-access')
      .send({ name: 'invalid-access-ns', accessPolicy: 'OPEN' })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'NAMESPACE_INVALID_ACCESS_POLICY' });
  });
});
