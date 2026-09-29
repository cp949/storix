import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';

const API_KEY = 'public-fs-integration-key';
const FILE_BODY = 'public-file-body';

describe('public namespace 다운로드 HTTP 계약', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let s3Container: StartedS3Container;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  let publicNamespaceId: string;
  let privateNamespaceId: string;

  async function createNamespace(name: string, accessPolicy: 'PRIVATE' | 'PUBLIC'): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name, accessPolicy })
      .expect(201);

    return response.body.id as string;
  }

  async function putFile(namespaceId: string, path: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent(path)}&parents=true`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Content-Type', 'text/plain')
      .send(FILE_BODY)
      .expect(201);
  }

  beforeAll(async () => {
    postgresContainer = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    s3Container = await startS3Container();

    process.env.STORIX_DB_HOST = postgresContainer.getHost();
    process.env.STORIX_DB_PORT = String(postgresContainer.getPort());
    process.env.STORIX_DB_USERNAME = postgresContainer.getUsername();
    process.env.STORIX_DB_PASSWORD = postgresContainer.getPassword();
    process.env.STORIX_DB_NAME = postgresContainer.getDatabase();
    process.env.STORIX_STORAGE_ENDPOINT = s3Container.getHost();
    process.env.STORIX_STORAGE_PORT = String(s3Container.getPort());
    process.env.STORIX_STORAGE_USE_SSL = 'false';
    process.env.STORIX_STORAGE_ACCESS_KEY = s3Container.getUsername();
    process.env.STORIX_STORAGE_SECRET_KEY = s3Container.getPassword();
    process.env.STORIX_STORAGE_BUCKET = 'storix-public-fs-test';
    process.env.STORIX_API_KEY = API_KEY;

    const minioClient = new MinioClient({
      endPoint: s3Container.getHost(),
      port: s3Container.getPort(),
      useSSL: false,
      accessKey: s3Container.getUsername(),
      secretKey: s3Container.getPassword(),
    });
    await minioClient.makeBucket(process.env.STORIX_STORAGE_BUCKET);

    migrationDataSource = new DataSource({
      type: 'postgres',
      url: postgresContainer.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS,
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
    await s3Container.stop();
  });

  it('PUBLIC namespace의 파일을 인증 없이 다운로드한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v2/public/${publicNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(200);

    expect(response.text).toBe(FILE_BODY);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-storix-file-id']).toBeUndefined();
    expect(response.headers['x-storix-revision']).toBeUndefined();
    expect(response.headers['x-storix-sha256']).toBeUndefined();
  });

  it('만료 예정 파일은 공개 읽기에서 없는 파일과 같은 404이고 확정 뒤에는 읽힌다', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${publicNamespaceId}/fs/content/conditional`)
      .query({ path: '/pending.txt' })
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Mutation-Scope', 'public-expiry')
      .set('X-If-Absent', 'true')
      .set('X-Expires-In', '600')
      .set('Content-Type', 'text/plain')
      .send(FILE_BODY)
      .expect(201);

    for (const route of ['content', 'download']) {
      const hidden = await request(app.getHttpServer())
        .get(`/api/v2/public/${publicNamespaceId}/fs/${route}`)
        .query({ path: '/pending.txt' })
        .expect(404);
      const missing = await request(app.getHttpServer())
        .get(`/api/v2/public/${publicNamespaceId}/fs/${route}`)
        .query({ path: '/never.txt' })
        .expect(404);
      expect(hidden.body.path).toBe('/pending.txt');
      expect(missing.body.path).toBe('/never.txt');
      const normalizeBody = (body: Record<string, unknown>, requestedPath: string) => ({
        ...body,
        message:
          typeof body.message === 'string' ? body.message.replaceAll(requestedPath, '<path>') : body.message,
        path: '<path>',
        requestId: undefined,
      });
      expect(normalizeBody(hidden.body, '/pending.txt')).toEqual(normalizeBody(missing.body, '/never.txt'));

      const authenticated = await request(app.getHttpServer())
        .get(`/api/v2/namespaces/${publicNamespaceId}/fs/${route}`)
        .query({ path: '/pending.txt' })
        .set('Authorization', `Bearer ${API_KEY}`)
        .expect(200);
      expect(authenticated.text).toBe(FILE_BODY);
    }

    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${publicNamespaceId}/fs/mutations`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Mutation-Scope', 'public-expiry')
      .send({ kind: 'persist', path: '/pending.txt', ifRevision: created.body.resource.revision })
      .expect(200);

    for (const route of ['content', 'download']) {
      const published = await request(app.getHttpServer())
        .get(`/api/v2/public/${publicNamespaceId}/fs/${route}`)
        .query({ path: '/pending.txt' })
        .expect(200);
      expect(published.text).toBe(FILE_BODY);
    }
  });

  it('content는 Content-Disposition을 설정하지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v2/public/${publicNamespaceId}/fs/content?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(200);

    expect(response.text).toBe(FILE_BODY);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['x-storix-file-id']).toBeUndefined();
    expect(response.headers['x-storix-revision']).toBeUndefined();
    expect(response.headers['x-storix-sha256']).toBeUndefined();
  });

  it('공개 파일 읽기도 정규 경로 alias를 해석하고 NFD를 거부한다', async () => {
    const base = `/api/v2/public/${publicNamespaceId}/fs/content`;
    const alias = await request(app.getHttpServer())
      .get(base)
      .query({ path: '/docs//./hello.txt/' })
      .expect(200);
    expect(alias.text).toBe(FILE_BODY);
    expect(
      (await request(app.getHttpServer()).get(base).query({ path: '/e\u0301' }).expect(400)).body.code,
    ).toBe('VFS_INVALID_PATH');
  });

  it('공개 파일 읽기의 복수 query path를 400 경로 오류로 거부한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v2/public/${publicNamespaceId}/fs/content?path=%2Fa&path=%2Fb`)
      .expect(400);
    expect(response.body.code).toBe('VFS_INVALID_PATH');
  });

  it('Range 요청에 206과 Content-Range를 반환한다', async () => {
    const stat = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${publicNamespaceId}/fs/stat`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path: '/docs/hello.txt' })
      .expect(200);
    const response = await request(app.getHttpServer())
      .get(`/api/v2/public/${publicNamespaceId}/fs/content?path=${encodeURIComponent('/docs/hello.txt')}`)
      .set('Range', 'bytes=0-5')
      .expect(206);

    expect(response.headers['content-range']).toBe(`bytes 0-5/${FILE_BODY.length}`);
    expect(response.headers['content-length']).toBe('6');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['x-storix-file-id']).toBe(stat.body.id);
    expect(response.headers['x-storix-revision']).toBe(stat.body.revision);
    expect(response.headers['x-storix-sha256']).toBeUndefined();
    expect(response.text).toBe(FILE_BODY.slice(0, 6));
    const download = await request(app.getHttpServer())
      .get(`/api/v2/public/${publicNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .set('Range', 'bytes=0-5')
      .expect(206);
    expect(download.text).toBe(FILE_BODY.slice(0, 6));
    expect(download.headers['content-range']).toBe(`bytes 0-5/${FILE_BODY.length}`);
    expect(download.headers['content-length']).toBe('6');
    expect(download.headers['accept-ranges']).toBe('bytes');
    expect(download.headers['x-storix-file-id']).toBe(stat.body.id);
    expect(download.headers['x-storix-revision']).toBe(stat.body.revision);
    expect(download.headers['x-storix-sha256']).toBeUndefined();
  });

  it('인증한 PRIVATE content/download 206은 원본 식별자를 보내고 200 헤더 정책을 유지한다', async () => {
    const base = `/api/v2/namespaces/${privateNamespaceId}/fs`;
    const path = '/docs/hello.txt';
    const stat = await request(app.getHttpServer())
      .get(`${base}/stat`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path })
      .expect(200);

    for (const route of ['content', 'download']) {
      await request(app.getHttpServer())
        .get(`${base}/${route}`)
        .query({ path })
        .set('Range', 'bytes=0-5')
        .expect(401);

      const ranged = await request(app.getHttpServer())
        .get(`${base}/${route}`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .query({ path })
        .set('Range', 'bytes=0-5')
        .expect(206);
      expect(ranged.text).toBe(FILE_BODY.slice(0, 6));
      expect(ranged.headers['content-range']).toBe(`bytes 0-5/${FILE_BODY.length}`);
      expect(ranged.headers['content-length']).toBe('6');
      expect(ranged.headers['accept-ranges']).toBe('bytes');
      expect(ranged.headers['x-storix-file-id']).toBe(stat.body.id);
      expect(ranged.headers['x-storix-revision']).toBe(stat.body.revision);
      expect(ranged.headers['x-storix-sha256']).toBeUndefined();
    }

    const inline = await request(app.getHttpServer())
      .get(`${base}/content`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path })
      .expect(200);
    expect(inline.text).toBe(FILE_BODY);
    expect(inline.headers['x-storix-file-id']).toBe(stat.body.id);
    expect(inline.headers['x-storix-revision']).toBe(stat.body.revision);
    expect(inline.headers['x-storix-sha256']).toBe(stat.body.sha256);

    const fullDownload = await request(app.getHttpServer())
      .get(`${base}/download`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path })
      .expect(200);
    expect(fullDownload.text).toBe(FILE_BODY);
    expect(fullDownload.headers['x-storix-file-id']).toBeUndefined();
    expect(fullDownload.headers['x-storix-revision']).toBeUndefined();
    expect(fullDownload.headers['x-storix-sha256']).toBeUndefined();
  });

  it('공개 파일의 복수 Range는 416과 전체 길이를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v2/public/${publicNamespaceId}/fs/content?path=${encodeURIComponent('/docs/hello.txt')}`)
      .set('Range', 'bytes=0-1,3-4')
      .expect(416);

    expect(response.headers['content-range']).toBe(`bytes */${FILE_BODY.length}`);
    expect(response.body).toEqual({
      code: 'VFS_RANGE_NOT_SATISFIABLE',
      message: '처리할 수 없는 Range: bytes=0-1,3-4',
      requestId: response.headers['x-request-id'],
    });
  });

  it.each(['bytes=abc-def', 'bytes=0-1,3-4', 'bytes=100-200', `bytes=${FILE_BODY.length}-`])(
    '인증한 PRIVATE 파일의 Range %s 거부는 416과 전체 길이를 반환한다',
    async (range) => {
      const path = `/api/v2/namespaces/${privateNamespaceId}/fs/content?path=${encodeURIComponent('/docs/hello.txt')}`;

      await request(app.getHttpServer()).get(path).set('Range', range).expect(401);

      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('Range', range)
        .expect(416);

      expect(response.headers['content-range']).toBe(`bytes */${FILE_BODY.length}`);
      expect(response.body).toEqual({
        code: 'VFS_RANGE_NOT_SATISFIABLE',
        message: `처리할 수 없는 Range: ${range}`,
        requestId: response.headers['x-request-id'],
      });
    },
  );

  it('인증한 빈 PRIVATE 파일의 Range는 416과 전체 길이 0을 반환한다', async () => {
    const base = `/api/v2/namespaces/${privateNamespaceId}/fs`;
    const path = '/empty-range.bin';
    const created = await request(app.getHttpServer())
      .post(`${base}/touch`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ path })
      .expect(201);
    expect(created.body.size).toBe(0);

    const response = await request(app.getHttpServer())
      .get(`${base}/content`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path })
      .set('Range', 'bytes=0-0')
      .expect(416);

    expect(response.headers['content-range']).toBe('bytes */0');
    expect(response.body).toEqual({
      code: 'VFS_RANGE_NOT_SATISFIABLE',
      message: '처리할 수 없는 Range: bytes=0-0',
      requestId: response.headers['x-request-id'],
    });
  });

  it('PRIVATE namespace를 공개 경로로 요청하면 404를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v2/public/${privateNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'NAMESPACE_NOT_FOUND' });
  });

  it('존재하지 않는 namespace를 공개 경로로 요청하면 404를 반환한다', async () => {
    await request(app.getHttpServer())
      .get(`/api/v2/public/${randomUUID()}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);
  });

  it('PRIVATE namespace와 존재하지 않는 namespace는 응답으로 서로 구별할 수 없다', async () => {
    const missingNamespaceId = randomUUID();

    const privateResponse = await request(app.getHttpServer())
      .get(`/api/v2/public/${privateNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);

    const missingResponse = await request(app.getHttpServer())
      .get(`/api/v2/public/${missingNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`)
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
      .get(
        `/api/v2/namespaces/${publicNamespaceId}/fs/download?path=${encodeURIComponent('/docs/hello.txt')}`,
      )
      .expect(401);
  });

  it('공개 경로에는 목록 조회 라우트가 없어 404를 반환한다', async () => {
    await request(app.getHttpServer())
      .get(`/api/v2/public/${publicNamespaceId}/fs/ls?path=/docs`)
      .expect(404);
  });

  it('v1 공개 경로는 제공하지 않는다', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/public/${publicNamespaceId}/fs/content?path=${encodeURIComponent('/docs/hello.txt')}`)
      .expect(404);
  });
});
