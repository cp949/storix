import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from '../persistence/migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from '../persistence/migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from '../persistence/migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from '../persistence/migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from '../persistence/migrations/1788637362016-InitSchema.js';
import { NamespaceModule } from './namespace.module.js';

describe('Namespace HTTP contract', () => {
  let container: StartedPostgreSqlContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();

    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getPort());
    process.env.DB_USERNAME = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.DB_NAME = container.getDatabase();
    process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64);

    migrationDataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: [
        InitSchema1788637362016,
        AddIdempotencyKey1788700000000,
        AddBlobZeroSince1788800000000,
        AddNamespaceResourceLimits1789000000000,
        AddEncryptionSupport1789100000000,
      ],
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

  it('Idempotency-Key 헤더가 없으면 400을 반환한다', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .send({ name: 'no-key-ns' })
      .expect(400);
  });

  it('name만으로 namespace를 생성하면 201과 함께 NONE/ACTIVE 상태를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'create-1')
      .send({ name: 'acme' })
      .expect(201);

    expect(response.body).toMatchObject({ name: 'acme', encryptionPolicy: 'NONE', status: 'ACTIVE' });
    expect(response.body.id).toEqual(expect.any(String));
  });

  it('같은 key와 같은 body로 재시도하면 새로 만들지 않고 같은 결과를 재생한다', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'create-retry')
      .send({ name: 'retry-ns' })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'create-retry')
      .send({ name: 'retry-ns' })
      .expect(201);

    expect(second.body).toEqual(first.body);
  });

  it('같은 key에 다른 body가 오면 422 IDEMPOTENCY_KEY_REUSED를 반환한다', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'reused-key')
      .send({ name: 'first-body' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
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
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'owner-key')
      .send({ name: 'conflict-ns' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'other-key')
      .send({ name: 'conflict-ns' })
      .expect(409);

    expect(response.body).toEqual({
      code: 'NAMESPACE_ALREADY_EXISTS',
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it('같은 key로 409 응답을 재시도해도 재생 응답에 requestId가 포함된다', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'owner-key-2')
      .send({ name: 'conflict-ns-2' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'retry-key')
      .send({ name: 'conflict-ns-2' })
      .expect(409);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
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
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'get-one-key')
      .send({ name: 'get-one-ns' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/namespaces/${created.body.id}`)
      .expect(200);

    expect(response.body).toEqual(created.body);
  });

  it('존재하지 않는 id를 단건 조회하면 404를 반환한다', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/namespaces/11111111-1111-1111-1111-111111111111')
      .expect(404);
  });

  it('생성한 namespace가 목록 조회에 포함된다', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'list-key')
      .send({ name: 'list-ns' })
      .expect(201);

    const response = await request(app.getHttpServer()).get('/api/v1/namespaces').expect(200);

    expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'list-ns' })]));
  });

  it('encryptionPolicy를 ENCRYPTED로 생성할 수 있다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', 'ns-encrypted-create')
      .send({ name: 'encrypted-ns', encryptionPolicy: 'ENCRYPTED' })
      .expect(201);

    expect(response.body).toMatchObject({ name: 'encrypted-ns', encryptionPolicy: 'ENCRYPTED' });
  });
});
