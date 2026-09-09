import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { configureBodyParsers } from '../common/body-parser.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { VfsModule } from './vfs.module.js';

const API_KEY = 'public-fs-integration-key';
const FILE_BODY = 'public-file-body';

describe('public namespace 다운로드 HTTP 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  let publicNamespaceId: string;
  let privateNamespaceId: string;

  async function createNamespace(name: string, accessPolicy: 'PRIVATE' | 'PUBLIC'): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name, accessPolicy })
      .expect(201);

    return response.body.id as string;
  }

  async function putFile(namespaceId: string, path: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/v1/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent(path)}&parents=true`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Content-Type', 'text/plain')
      .send(FILE_BODY)
      .expect(201);
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
    process.env.STORIX_STORAGE_BUCKET = 'storix-public-fs-test';
    process.env.STORIX_API_KEY = API_KEY;

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
      migrations: ALL_MIGRATIONS.slice(0, 3),
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule, VfsModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();

    publicNamespaceId = await createNamespace('public-download-ns', 'PUBLIC');
    privateNamespaceId = await createNamespace('private-download-ns', 'PRIVATE');
    await putFile(publicNamespaceId, '/docs/hello.txt');
    await putFile(privateNamespaceId, '/docs/hello.txt');
  }, 180000);

  afterAll(async () => {
    await app.close();
    await migrationDataSource.destroy();
    await postgresContainer.stop();
    await minioContainer.stop();
  });

  it('PUBLIC namespace의 파일을 인증 없이 다운로드한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/public/${publicNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(200);

    expect(response.text).toBe(FILE_BODY);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('content는 Content-Disposition을 설정하지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/public/${publicNamespaceId}/fs/content?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(200);

    expect(response.text).toBe(FILE_BODY);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('Range 요청에 206과 Content-Range를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/public/${publicNamespaceId}/fs/content?path=${encodeURIComponent('/docs/hello.txt')}`)
      .set('Range', 'bytes=0-5')
      .expect(206);

    expect(response.headers['content-range']).toBe(`bytes 0-5/${FILE_BODY.length}`);
    expect(response.text).toBe(FILE_BODY.slice(0, 6));
  });

  it('PRIVATE namespace를 공개 경로로 요청하면 404를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/public/${privateNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'NAMESPACE_NOT_FOUND' });
  });

  it('존재하지 않는 namespace를 공개 경로로 요청하면 404를 반환한다', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/public/${randomUUID()}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);
  });

  it('PRIVATE namespace와 존재하지 않는 namespace는 응답으로 서로 구별할 수 없다', async () => {
    const missingNamespaceId = randomUUID();

    const privateResponse = await request(app.getHttpServer())
      .get(`/api/v1/public/${privateNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);

    const missingResponse = await request(app.getHttpServer())
      .get(`/api/v1/public/${missingNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);

    // DomainErrorFilter가 채우는 필드는 code/message/path/requestId. requestId는
    // 요청마다 무작위로 발급되니 비교에서 제외한다. message는 "존재하지 않는
    // namespace: {요청한 id}" 템플릿이라 요청 URL의 id를 그대로 되돌려줄 뿐이므로,
    // 실제로 PRIVATE라서 막혔는지 진짜 없는 id라서 막혔는지와는 무관하다 — 두
    // 응답 각각의 id를 동일한 placeholder로 치환하면 완전히 같아져야 한다.
    const normalizeBody = (body: Record<string, unknown>, requestedNamespaceId: string) => ({
      ...body,
      message:
        typeof body.message === 'string'
          ? body.message.replaceAll(requestedNamespaceId, '<namespaceId>')
          : body.message,
      requestId: undefined,
    });

    expect(privateResponse.status).toBe(missingResponse.status);
    expect(normalizeBody(privateResponse.body, privateNamespaceId)).toEqual(
      normalizeBody(missingResponse.body, missingNamespaceId),
    );
  });

  it('PUBLIC namespace라도 기존 인증 경로는 API key가 없으면 401을 반환한다', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/namespaces/${publicNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(401);
  });

  it('공개 경로에는 목록 조회 라우트가 없어 404를 반환한다', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/public/${publicNamespaceId}/fs/ls?path=/docs`)
      .expect(404);
  });
});
