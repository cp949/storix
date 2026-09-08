import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureBodyParsers } from '../common/body-parser.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from '../persistence/migrations/1788800000000-AddBlobZeroSince.js';
import { AddEncryptionSupport1789100000000 } from '../persistence/migrations/1789100000000-AddEncryptionSupport.js';
import { AddIdempotencyKey1788700000000 } from '../persistence/migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from '../persistence/migrations/1789000000000-AddNamespaceResourceLimits.js';
import { InitSchema1788637362016 } from '../persistence/migrations/1788637362016-InitSchema.js';
import { VfsModule } from './vfs.module.js';

const MASTER_KEY_HEX = 'cd'.repeat(32);

describe('presigned-download HTTP 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let migrationDataSource: DataSource;
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
    process.env.STORIX_STORAGE_BUCKET = 'storix-presigned-test';
    // 테스트 환경에서는 testcontainers가 노출하는 주소가 곧 "외부에서 접근 가능한"
    // 주소이므로 내부/퍼블릭 값을 동일하게 맞춘다.
    process.env.STORIX_STORAGE_PUBLIC_ENDPOINT = minioContainer.getHost();
    process.env.STORIX_STORAGE_PUBLIC_PORT = String(minioContainer.getPort());
    process.env.STORIX_STORAGE_PUBLIC_USE_SSL = 'false';
    process.env.STORIX_MAX_FILE_SIZE_BYTES = String(1024 * 1024 * 1024);
    process.env.STORIX_MAX_SYNC_DELETE_NODES = '1000';
    process.env.STORIX_MAX_SYNC_COPY_NODES = '1000';
    process.env.STORIX_PRESIGNED_URL_EXPIRY_SECONDS = '300';
    process.env.STORIX_ENCRYPTION_MASTER_KEY = MASTER_KEY_HEX;

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
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule, VfsModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();
    httpServer = app.getHttpServer();
  }, 180000);

  afterAll(async () => {
    await app.close();
    await migrationDataSource.destroy();
    await postgresContainer.stop();
    await minioContainer.stop();
  });

  async function createNamespace(name: string): Promise<string> {
    const response = await request(httpServer)
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);
    return response.body.id;
  }

  async function createEncryptedNamespace(name: string): Promise<string> {
    const response = await request(httpServer)
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name, encryptionPolicy: 'ENCRYPTED' })
      .expect(201);
    return response.body.id;
  }

  it('NONE namespace의 파일은 presigned URL로 원본 콘텐츠를 직접 받을 수 있다', async () => {
    const namespaceId = await createNamespace(`presigned-ok-${randomUUID()}`);
    const content = 'hello presigned world';

    await request(httpServer)
      .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/report.txt' })
      .set('Content-Type', 'text/plain')
      .send(content)
      .expect(201);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/presigned-download`)
      .query({ path: '/report.txt' })
      .expect(200);

    expect(typeof response.body.url).toBe('string');
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const fetched = await fetch(response.body.url as string);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(content);
    expect(fetched.headers.get('content-disposition')).toContain('report.txt');
  });

  it('존재하지 않는 경로는 404를 반환한다', async () => {
    const namespaceId = await createNamespace(`presigned-404-${randomUUID()}`);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/presigned-download`)
      .query({ path: '/missing.txt' })
      .expect(404);

    expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
  });

  it('디렉터리 대상은 409를 반환한다', async () => {
    const namespaceId = await createNamespace(`presigned-dir-${randomUUID()}`);
    await request(httpServer)
      .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
      .send({ path: '/dir' })
      .expect(201);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/presigned-download`)
      .query({ path: '/dir' })
      .expect(409);

    expect(response.body.code).toBe('VFS_IS_DIRECTORY');
  });

  it('ENCRYPTED namespace의 파일은 409로 거부된다', async () => {
    const namespaceId = await createEncryptedNamespace(`presigned-enc-${randomUUID()}`);
    await request(httpServer)
      .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/secret.txt' })
      .set('Content-Type', 'text/plain')
      .send('top secret')
      .expect(201);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/presigned-download`)
      .query({ path: '/secret.txt' })
      .expect(409);

    expect(response.body.code).toBe('VFS_PRESIGNED_ENCRYPTED_UNSUPPORTED');
  });
});
