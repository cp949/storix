import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource, IsNull } from 'typeorm';
import { configureBodyParsers } from '../common/body-parser.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from '../persistence/migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from '../persistence/migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from '../persistence/migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from '../persistence/migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from '../persistence/migrations/1788637362016-InitSchema.js';
import { VfsModule } from './vfs.module.js';

const MAX_FILE_SIZE_BYTES = 1048576;

function putChunked(
  port: number,
  path: string,
  chunks: Buffer[],
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'PUT', headers: { 'content-type': 'application/octet-stream' } },
      (res) => {
        const data: Buffer[] = [];
        res.on('data', (chunk: Buffer) => data.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(data).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);

    (async () => {
      for (const chunk of chunks) {
        if (!req.write(chunk)) {
          await once(req, 'drain');
        }
      }
      req.end();
    })().catch(reject);
  });
}

describe('Fs HTTP contract', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let serverPort: number;

  beforeAll(async () => {
    postgresContainer = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    minioContainer = await new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start();

    process.env.DB_HOST = postgresContainer.getHost();
    process.env.DB_PORT = String(postgresContainer.getPort());
    process.env.DB_USERNAME = postgresContainer.getUsername();
    process.env.DB_PASSWORD = postgresContainer.getPassword();
    process.env.DB_NAME = postgresContainer.getDatabase();
    process.env.MINIO_ENDPOINT = minioContainer.getHost();
    process.env.MINIO_PORT = String(minioContainer.getPort());
    process.env.MINIO_USE_SSL = 'false';
    process.env.MINIO_ACCESS_KEY = minioContainer.getUsername();
    process.env.MINIO_SECRET_KEY = minioContainer.getPassword();
    process.env.MINIO_BUCKET = 'storix-fs-test';
    process.env.MAX_FILE_SIZE_BYTES = String(MAX_FILE_SIZE_BYTES);
    process.env.MAX_SYNC_DELETE_NODES = '5';
    process.env.MAX_SYNC_COPY_NODES = '5';

    const minioClient = new MinioClient({
      endPoint: minioContainer.getHost(),
      port: minioContainer.getPort(),
      useSSL: false,
      accessKey: minioContainer.getUsername(),
      secretKey: minioContainer.getPassword(),
    });
    await minioClient.makeBucket(process.env.MINIO_BUCKET);

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
    await app.listen(0);
    httpServer = app.getHttpServer();
    serverPort = (httpServer.address() as { port: number }).port;
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

  async function createFileDirectly(namespaceId: string, parentId: string, name: string) {
    const blobRepo = migrationDataSource.getRepository(BlobEntity);
    const nodeRepo = migrationDataSource.getRepository(VfsNodeEntity);
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey: `blobs/00/${randomUUID()}`,
        size: '0',
        mimeType: 'application/octet-stream',
        sha256: '0'.repeat(64),
        referenceCount: 1,
      }),
    );

    return nodeRepo.save(
      nodeRepo.create({
        namespaceId,
        parentId,
        type: 'FILE',
        name,
        blobId: blob.id,
        size: '0',
        mimeType: 'application/octet-stream',
      }),
    );
  }

  describe('공통 검증', () => {
    it('존재하지 않는 namespace는 404를 반환한다', async () => {
      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${randomUUID()}/fs/stat`)
        .query({ path: '/' })
        .expect(404);

      expect(response.body).toEqual({
        code: 'NAMESPACE_NOT_FOUND',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('경로에 ..이 있으면 400 VFS_INVALID_PATH를 반환한다', async () => {
      const namespaceId = await createNamespace('invalid-path-ns');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/a/../b' })
        .expect(400);

      expect(response.body).toEqual({
        code: 'VFS_INVALID_PATH',
        message: expect.any(String),
        path: expect.any(String),
        requestId: expect.any(String),
      });
    });
  });

  describe('mkdir', () => {
    it('parents=false로 root 바로 아래 디렉터리를 생성하면 201을 반환한다', async () => {
      const namespaceId = await createNamespace('mkdir-basic-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/docs' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/docs', name: 'docs', type: 'DIRECTORY' });
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await createNamespace('mkdir-default-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('parents=true면 mkdir -p처럼 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespaceId = await createNamespace('mkdir-p-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b/c', parents: true })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a/b/c', name: 'c' });

      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a/b' })
        .expect(200);
    });

    it('이미 존재하는 디렉터리를 parents=false로 다시 만들면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await createNamespace('mkdir-conflict-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dup' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dup' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });
  });

  describe('ls', () => {
    it('name ASC, id ASC 순서로 자식을 나열한다', async () => {
      const namespaceId = await createNamespace('ls-order-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/b' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/' })
        .expect(200);

      expect(response.body.items.map((i: { name: string }) => i.name)).toEqual(['a', 'b']);
      expect(response.body.nextCursor).toBeNull();
    });

    it('limit을 넘는 항목이 있으면 nextCursor로 다음 페이지를 조회할 수 있다', async () => {
      const namespaceId = await createNamespace('ls-cursor-ns');
      for (const name of ['a', 'b', 'c']) {
        await request(httpServer)
          .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
          .send({ path: `/${name}` })
          .expect(201);
      }

      const first = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', limit: 2 })
        .expect(200);

      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', limit: 2, cursor: first.body.nextCursor })
        .expect(200);

      expect(second.body.items.map((i: { name: string }) => i.name)).toEqual(['c']);
      expect(second.body.nextCursor).toBeNull();
    });

    it('잘못된 형식의 cursor는 400 VFS_INVALID_CURSOR를 반환한다', async () => {
      const namespaceId = await createNamespace('ls-invalid-cursor-ns');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', cursor: 'not-a-valid-cursor' })
        .expect(400);

      expect(response.body).toEqual({
        code: 'VFS_INVALID_CURSOR',
        message: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('대상이 FILE이면 409 VFS_NOT_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('ls-on-file-ns');
      const rootStat = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });

      await createFileDirectly(namespaceId, rootStat.id, 'file.txt');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/file.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });

    it('존재하지 않는 경로는 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await createNamespace('ls-missing-ns');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/nope' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });
  });

  describe('stat / exists', () => {
    it('stat이 생성한 디렉터리 정보를 반환한다', async () => {
      const namespaceId = await createNamespace('stat-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(200);

      expect(response.body).toMatchObject({ path: '/a', name: 'a', type: 'DIRECTORY' });
    });

    it('exists는 없는 경로에 대해 404 대신 exists:false를 반환한다', async () => {
      const namespaceId = await createNamespace('exists-false-ns');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/exists`)
        .query({ path: '/nope' })
        .expect(200);

      expect(response.body).toEqual({ exists: false });
    });

    it('exists는 있는 경로에 대해 exists:true를 반환한다', async () => {
      const namespaceId = await createNamespace('exists-true-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/exists`)
        .query({ path: '/a' })
        .expect(200);

      expect(response.body).toEqual({ exists: true });
    });
  });

  describe('find', () => {
    it('시작 경로 하위를 재귀적으로 검색한다', async () => {
      const namespaceId = await createNamespace('find-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/' })
        .expect(200);

      expect(response.body.items.map((i: { path: string }) => i.path).sort()).toEqual(['/a', '/a/b']);
    });

    it('name/match/type 필터를 조합해 검색한다', async () => {
      const namespaceId = await createNamespace('find-filter-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/report-2026', parents: true })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/notes', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/', name: 'report', match: 'contains', type: 'DIRECTORY' })
        .expect(200);

      expect(response.body.items.map((i: { name: string }) => i.name)).toEqual(['report-2026']);
    });

    it('시작 경로가 FILE이면 409 VFS_NOT_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('find-on-file-ns');
      const rootStat = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });
      await createFileDirectly(namespaceId, rootStat.id, 'file.txt');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/file.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });
  });

  describe('touch', () => {
    it('없는 file을 0-byte로 생성하면 201을 반환한다', async () => {
      const namespaceId = await createNamespace('touch-create-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a.txt', name: 'a.txt', type: 'FILE', size: 0 });
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await createNamespace('touch-no-parent-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/b.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('parents=true면 중간 디렉터리를 생성하며 file을 만든다', async () => {
      const namespaceId = await createNamespace('touch-parents-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/b.txt', parents: true })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a/b.txt', name: 'b.txt' });
    });

    it('기존 file을 다시 touch하면 200과 함께 version이 올라간다', async () => {
      const namespaceId = await createNamespace('touch-existing-ns');
      const first = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const second = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(200);

      expect(second.body.version).toBe(first.body.version + 1);
    });

    it('directory를 touch하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('touch-dir-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/adir' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });
  });

  describe('PUT/GET content', () => {
    it('없는 file에 내용을 올리면 201과 함께 size/mimeType이 반영된다', async () => {
      const namespaceId = await createNamespace('put-create-ns');

      const putResponse = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      expect(putResponse.body).toMatchObject({ path: '/a.txt', size: 12, mimeType: 'text/plain' });

      const getResponse = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.text).toBe('hello storix');
      expect(getResponse.headers['content-type']).toBe('text/plain');
    });

    it('같은 새 경로에 동시 업로드하면 하나만 생성하고 나머지는 version conflict를 반환한다', async () => {
      const namespaceId = await createNamespace('put-concurrent-create-ns');
      const path = '/same-path.txt';

      const responses = await Promise.all(
        ['first', 'second'].map((content) =>
          request(httpServer)
            .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
            .query({ path })
            .set('Content-Type', 'text/plain')
            .send(content),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(responses.find((response) => response.status === 409)?.body.code).toBe('VFS_VERSION_CONFLICT');
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await createNamespace('put-no-parent-ns');

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a/b.txt' })
        .send('x')
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('directory 대상에 업로드하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('put-dir-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/adir' })
        .send('x')
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('If-Match 없이 기존 file을 덮어쓰려 하면 409 VFS_VERSION_CONFLICT를 반환한다', async () => {
      const namespaceId = await createNamespace('put-no-if-match-ns');
      await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v2')
        .expect(409);

      expect(response.body.code).toBe('VFS_VERSION_CONFLICT');
    });

    it('올바른 If-Match version이면 덮어쓴다', async () => {
      const namespaceId = await createNamespace('put-if-match-ns');
      const created = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const overwritten = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('If-Match', String(created.body.version))
        .send('version 2 content')
        .expect(200);

      expect(overwritten.body.size).toBe(Buffer.byteLength('version 2 content'));

      const getResponse = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.text).toBe('version 2 content');
    });

    it('force=true면 If-Match 없이도 덮어쓴다', async () => {
      const namespaceId = await createNamespace('put-force-ns');
      await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt', force: 'true' })
        .send('forced overwrite')
        .expect(200);

      expect(response.body.size).toBe(Buffer.byteLength('forced overwrite'));
    });

    it('Content-Type이 없으면 application/octet-stream으로 저장한다', async () => {
      const namespaceId = await createNamespace('put-default-mime-ns');

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.bin' })
        .send(Buffer.from([1, 2, 3]))
        .expect(201);

      expect(response.body.mimeType).toBe('application/octet-stream');
    });

    it('Content-Length가 MAX_FILE_SIZE_BYTES를 넘으면 413 VFS_FILE_TOO_LARGE를 반환한다', async () => {
      const namespaceId = await createNamespace('put-length-too-large-ns');
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/big.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(oversized)
        .expect(413);

      expect(response.body.code).toBe('VFS_FILE_TOO_LARGE');
    });

    it('chunked stream이 MAX_FILE_SIZE_BYTES를 넘으면 413 VFS_FILE_TOO_LARGE로 중단한다', async () => {
      const namespaceId = await createNamespace('put-chunked-too-large-ns');
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024, 1);
      const midpoint = Math.floor(oversized.length / 2);

      const response = await putChunked(
        serverPort,
        `/api/v1/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big.bin')}`,
        [oversized.subarray(0, midpoint), oversized.subarray(midpoint)],
      );

      expect(response.status).toBe(413);
      expect((response.body as { code: string }).code).toBe('VFS_FILE_TOO_LARGE');
    });

    it('namespace의 max_file_size_bytes가 전역 한도보다 작으면 그 값을 넘는 요청을 413 VFS_FILE_TOO_LARGE로 거부한다', async () => {
      const namespaceId = await createNamespace('put-namespace-limit-ns');
      const namespaceLimit = 100;
      // 전역 한도(MAX_FILE_SIZE_BYTES=1MiB)보다는 훨씬 작지만 namespace 한도보다는 큰
      // 크기로 요청해, 실제로 namespace 한도가 적용되는지(전역 한도만 걸리는 게 아닌지)를
      // HTTP 스택 전체(라우팅~DB~에러 필터)를 통해 검증한다.
      await migrationDataSource
        .getRepository(NamespaceEntity)
        .update(namespaceId, { maxFileSizeBytes: String(namespaceLimit) });

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/ns-limited.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(namespaceLimit + 1))
        .expect(413);

      expect(response.body.code).toBe('VFS_FILE_TOO_LARGE');
    });

    it('GET content 대상이 없으면 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await createNamespace('get-missing-ns');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/nope.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('GET content 대상이 directory면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('get-dir-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/adir' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('빈 body로 PUT content를 호출하면 0-byte file을 생성한다', async () => {
      const namespaceId = await createNamespace('put-empty-body-ns');

      const response = await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/empty.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0))
        .expect(201);

      expect(response.body.size).toBe(0);

      const getResponse = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/empty.bin' })
        .expect(200);

      // application/octet-stream 응답은 superagent가 res.text가 아닌 res.body(Buffer)로 파싱한다.
      expect(Buffer.isBuffer(getResponse.body)).toBe(true);
      expect(getResponse.body).toHaveLength(0);
      expect(getResponse.headers['content-length']).toBe('0');
    });

    it('업로드 도중 클라이언트가 연결을 끊어도 서버 프로세스는 살아남고 이후 요청을 정상 처리한다', async () => {
      const namespaceId = await createNamespace('put-client-abort-ns');

      await new Promise<void>((resolve) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: serverPort,
          path: `/api/v1/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/aborted.bin')}`,
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
        });
        // 클라이언트 쪽에서 강제로 소켓을 끊었을 때 발생하는 오류 이벤트는 이 테스트의
        // 관심사가 아니다(리스너가 없으면 Node가 미처리 예외로 취급해 테스트 프로세스가
        // 죽으므로 반드시 무시하는 리스너를 달아둔다).
        req.on('error', () => undefined);

        req.write(Buffer.alloc(64 * 1024, 1));
        req.write(Buffer.alloc(64 * 1024, 2));

        // 서버가 실제로 요청을 라우팅하고(네임스페이스/경로 조회 등 실제 DB 왕복 포함)
        // body를 소비하기 시작할 시간을 준 뒤 소켓을 강제로 파괴해, 업로드가 실제로
        // 진행되는 도중에 클라이언트 연결이 끊기는 상황(네트워크 단절, LB 타임아웃 등)을
        // 재현한다 — 너무 빨리 끊으면 서버가 요청을 라우팅하기도 전에 연결이 끊겨
        // 버그를 재현하지 못한다.
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 200);
      });

      // 서버 프로세스가 죽지 않았는지는, 완전히 무관한 이후 요청이 같은 서버에서
      // 정상적으로 처리되는지로 검증한다 — 프로세스가 죽었다면 이 요청 자체가 실패한다.
      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/still-alive.txt' })
        .expect(201);

      expect(response.body).toMatchObject({
        path: '/still-alive.txt',
        name: 'still-alive.txt',
        type: 'FILE',
      });
    });
  });

  describe('Range 요청', () => {
    async function putText(namespaceId: string, path: string, text: string) {
      return request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path })
        .set('Content-Type', 'text/plain')
        .send(text)
        .expect(201);
    }

    it('유효한 range는 206과 Content-Range를 반환한다', async () => {
      const namespaceId = await createNamespace('range-valid-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=2-4')
        .expect(206);

      expect(response.text).toBe('234');
      expect(response.headers['content-range']).toBe('bytes 2-4/10');
    });

    it('열린 끝 range(bytes=5-)는 나머지 전체를 반환한다', async () => {
      const namespaceId = await createNamespace('range-open-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=5-')
        .expect(206);

      expect(response.text).toBe('56789');
    });

    it('suffix range(bytes=-3)는 마지막 N byte를 반환한다', async () => {
      const namespaceId = await createNamespace('range-suffix-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=-3')
        .expect(206);

      expect(response.text).toBe('789');
    });

    it('여러 range를 요청하면 416을 반환한다', async () => {
      const namespaceId = await createNamespace('range-multi-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=0-1,3-4')
        .expect(416);

      expect(response.body.code).toBe('VFS_RANGE_NOT_SATISFIABLE');
    });

    it('범위를 벗어난 range는 416을 반환한다', async () => {
      const namespaceId = await createNamespace('range-oob-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=100-200')
        .expect(416);

      expect(response.body.code).toBe('VFS_RANGE_NOT_SATISFIABLE');
    });
  });

  describe('download', () => {
    it('Content-Disposition에 안전하게 인코딩한 filename을 담는다', async () => {
      const namespaceId = await createNamespace('download-ns');
      await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/보고서.txt' })
        .set('Content-Type', 'text/plain')
        .send('내용')
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/download`)
        .query({ path: '/보고서.txt' })
        .expect(200);

      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="___.txt"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.txt`,
      );
    });

    it('다운로드 도중 클라이언트가 연결을 끊어도 서버 프로세스는 살아남고 이후 요청을 정상 처리한다', async () => {
      const namespaceId = await createNamespace('download-client-abort-ns');
      // MAX_FILE_SIZE_BYTES(1MiB) 이하에서 스트리밍 도중 끊을 시간을 벌기 위해 큼직하게 채운다.
      const content = Buffer.alloc(900 * 1024, 7);

      await putChunked(
        serverPort,
        `/api/v1/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big-download.bin')}`,
        [content],
      );

      await new Promise<void>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: serverPort,
            path: `/api/v1/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big-download.bin')}`,
            method: 'GET',
          },
          () => {
            // 응답 body를 전혀 소비하지 않아(res.resume()을 호출하지 않음) 서버 쪽에
            // backpressure가 걸린 채로 스트리밍이 진행 중인 상태를 유지한 뒤 소켓을
            // 강제로 파괴해 다운로드 도중 클라이언트 연결이 끊기는 상황을 재현한다.
            setTimeout(() => {
              req.destroy();
              resolve();
            }, 100);
          },
        );
        req.on('error', () => undefined);
        req.end();
      });

      // 서버 프로세스가 죽지 않았는지는, 완전히 무관한 이후 요청이 같은 서버에서
      // 정상적으로 처리되는지로 검증한다 — 프로세스가 죽었다면 이 요청 자체가 실패한다.
      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/still-alive-after-download-abort.txt' })
        .expect(201);

      expect(response.body).toMatchObject({
        path: '/still-alive-after-download-abort.txt',
        name: 'still-alive-after-download-abort.txt',
        type: 'FILE',
      });
    });
  });

  describe('mv', () => {
    it('같은 디렉터리 내에서 이름을 바꾸면 200과 새 경로를 반환한다', async () => {
      const namespaceId = await createNamespace('mv-rename-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(200);

      expect(response.body).toMatchObject({ path: '/b.txt', name: 'b.txt' });
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(404);
    });

    it('목적지가 기존 디렉터리면 그 아래로 배치한다', async () => {
      const namespaceId = await createNamespace('mv-nest-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dest' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/dest' })
        .expect(200);

      expect(response.body.path).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 중간 디렉터리를 생성한다', async () => {
      const namespaceId = await createNamespace('mv-parents-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/x/y/a.txt', destinationParents: true })
        .expect(200);

      expect(response.body.path).toBe('/x/y/a.txt');
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/x' })
        .expect(200);
    });

    it('destinationParents 기본값 false로 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await createNamespace('mv-no-parents-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/x/a.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('목적지 경로가 이미 있으면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await createNamespace('mv-conflict-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/b.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });

    it('디렉터리를 자기 subtree 아래로 이동하면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await createNamespace('mv-subtree-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a', destination: '/a/b' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('source가 root(/)이면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await createNamespace('mv-root-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/', destination: '/x' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('존재하지 않는 source는 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await createNamespace('mv-missing-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/missing.txt', destination: '/x.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });
  });

  describe('cp', () => {
    it('file을 복사하면 201과 새 경로를 반환하고 원본은 그대로 남는다', async () => {
      const namespaceId = await createNamespace('cp-file-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/b.txt', name: 'b.txt' });
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(200);
    });

    it('복사본이 원본과 같은 content를 서빙하고, 복사본에 write해도 원본 content는 그대로다', async () => {
      const namespaceId = await createNamespace('cp-content-ns');
      await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(201);

      const copiedContent = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .expect(200);
      expect(copiedContent.text).toBe('hello storix');

      const stat = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/b.txt' })
        .expect(200);

      await request(httpServer)
        .put(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .set('If-Match', String(stat.body.version))
        .set('Content-Type', 'text/plain')
        .send('changed')
        .expect(200);

      const originalAfterWrite = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(originalAfterWrite.text).toBe('hello storix');

      const copiedAfterWrite = await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .expect(200);
      expect(copiedAfterWrite.text).toBe('changed');
    });

    it('목적지가 기존 디렉터리면 그 아래로 배치한다', async () => {
      const namespaceId = await createNamespace('cp-nest-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dest' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/dest' })
        .expect(201);

      expect(response.body.path).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 중간 디렉터리를 생성한다', async () => {
      const namespaceId = await createNamespace('cp-parents-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/x/y/a.txt', destinationParents: true })
        .expect(201);

      expect(response.body.path).toBe('/x/y/a.txt');
    });

    it('목적지가 이미 있으면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await createNamespace('cp-conflict-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/b.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });

    it('디렉터리를 자기 subtree 아래로 복사하면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await createNamespace('cp-subtree-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a', destination: '/a/b' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('디렉터리를 재귀적으로 복사하면 하위 file마다 새 Node를 만들고 원본은 그대로 남는다', async () => {
      const namespaceId = await createNamespace('cp-recursive-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/src/nested', parents: true })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/src/a.txt' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/src/nested/b.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/src', destination: '/dst' })
        .expect(201);

      expect(response.body.path).toBe('/dst');
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/dst/a.txt' })
        .expect(200);
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/dst/nested/b.txt' })
        .expect(200);
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/src/a.txt' })
        .expect(200);
    });

    it('MAX_SYNC_COPY_NODES를 넘는 recursive 복사는 시작 전에 413을 반환하고 아무것도 만들지 않는다', async () => {
      const namespaceId = await createNamespace('cp-limit-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/big' })
        .expect(201);
      for (const name of ['1', '2', '3', '4', '5']) {
        await request(httpServer)
          .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
          .send({ path: `/big/${name}.txt` })
          .expect(201);
      }
      // big 자신 + file 5개 = 6개 Node > 스위트 상한(5)

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/big', destination: '/copy' })
        .expect(413);

      expect(response.body.code).toBe('VFS_COPY_LIMIT_EXCEEDED');
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/copy' })
        .expect(404);
    });

    it('root는 복사할 수 없다', async () => {
      const namespaceId = await createNamespace('cp-root-ns');

      const response = await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/', destination: '/x' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });

  describe('rmdir', () => {
    it('빈 디렉터리를 삭제하면 204를 반환한다', async () => {
      const namespaceId = await createNamespace('rmdir-empty-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a' })
        .expect(204);

      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(404);
    });

    it('비어 있지 않은 디렉터리는 409 VFS_DIRECTORY_NOT_EMPTY를 반환한다', async () => {
      const namespaceId = await createNamespace('rmdir-nonempty-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/x.txt' })
        .expect(201);

      const response = await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a' })
        .expect(409);

      expect(response.body.code).toBe('VFS_DIRECTORY_NOT_EMPTY');
    });

    it('FILE 대상이면 409 VFS_NOT_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('rmdir-file-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });

    it('root는 삭제할 수 없다', async () => {
      const namespaceId = await createNamespace('rmdir-root-ns');

      const response = await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });

  describe('rm', () => {
    it('file을 삭제하면 204를 반환하고 이후 조회에서 사라진다', async () => {
      const namespaceId = await createNamespace('rm-file-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a.txt' })
        .expect(204);

      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(404);
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(404);
    });

    it('recursive=false로 directory를 삭제하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('rm-dir-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('recursive=true면 하위 트리를 모두 삭제한다', async () => {
      const namespaceId = await createNamespace('rm-recursive-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/x.txt' })
        .expect(201);

      await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a', recursive: 'true' })
        .expect(204);

      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(404);
    });

    it('MAX_SYNC_DELETE_NODES를 넘는 recursive 삭제는 시작 전에 413을 반환하고 아무것도 지우지 않는다', async () => {
      const namespaceId = await createNamespace('rm-limit-ns');
      await request(httpServer)
        .post(`/api/v1/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/big' })
        .expect(201);
      for (const name of ['1', '2', '3', '4', '5']) {
        await request(httpServer)
          .post(`/api/v1/namespaces/${namespaceId}/fs/touch`)
          .send({ path: `/big/${name}.txt` })
          .expect(201);
      }
      // big 자신 + file 5개 = 6개 Node > 스위트 상한(5)

      const response = await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/big', recursive: 'true' })
        .expect(413);

      expect(response.body.code).toBe('VFS_DELETE_LIMIT_EXCEEDED');
      await request(httpServer)
        .get(`/api/v1/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/big/1.txt' })
        .expect(200);
    });

    it('root는 삭제할 수 없다', async () => {
      const namespaceId = await createNamespace('rm-root-ns');

      const response = await request(httpServer)
        .delete(`/api/v1/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/', recursive: 'true' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });
});
