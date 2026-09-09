import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
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
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { VfsModule } from './vfs.module.js';

const CHUNK_SIZE = 1024 * 1024;
const LARGE_FILE_CHUNKS = 200;
// 실측 기준 peak RSS 증가량은 파일 크기(200MiB/400MiB)와 무관하게 133~140MiB 수준의
// 고정 오버헤드(파트 단위 스트리밍 파이프라인 자체의 버퍼링 여유분)로 확인되었다.
// 200MiB는 이 실측치 대비 약 43% 여유를 두면서도, 수정 전 버그(파일 크기에 비례해
// 200MiB 파일 기준 약 434MiB까지 증가하던 통버퍼링)의 절반 미만이라 회귀 발생 시
// 여전히 확실히 감지한다.
const MEMORY_GROWTH_LIMIT_BYTES = 200 * 1024 * 1024;

function* generateChunks(total: number, size: number): Generator<Buffer> {
  for (let i = 0; i < total; i += 1) {
    yield Buffer.alloc(size, i % 256);
  }
}

function postStreaming(port: number, path: string, chunkCount: number, chunkSize: number): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/octet-stream' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);

    (async () => {
      for (const chunk of generateChunks(chunkCount, chunkSize)) {
        if (!req.write(chunk)) {
          await once(req, 'drain');
        }
      }
      req.end();
    })().catch(reject);
  });
}

function getStreamingHash(port: number, path: string): Promise<{ status: number; sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const hash = createHash('sha256');
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, sha256: hash.digest('hex'), size }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('대용량 스트리밍', () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  let serverPort: number;

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
    process.env.STORIX_STORAGE_BUCKET = 'storix-streaming-test';
    process.env.STORIX_MAX_FILE_SIZE_BYTES = String(1024 * 1024 * 1024);
    process.env.STORIX_MAX_SYNC_DELETE_NODES = '1000';
    process.env.STORIX_MAX_SYNC_COPY_NODES = '1000';

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
      migrations: ALL_MIGRATIONS.slice(0, 5),
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
    serverPort = (app.getHttpServer().address() as { port: number }).port;
  }, 180000);

  afterAll(async () => {
    await app.close();
    await migrationDataSource.destroy();
    await postgresContainer.stop();
    await minioContainer.stop();
  });

  async function createNamespace(name: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name })
      .expect(201);

    return response.body.id;
  }

  it(`${LARGE_FILE_CHUNKS}MiB 파일을 업로드해도 메모리 증가가 파일 크기보다 훨씬 작다`, async () => {
    const namespaceId = await createNamespace('streaming-memory-ns');

    (globalThis as { gc?: () => void }).gc?.();
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const samplingTimer = setInterval(() => {
      const current = process.memoryUsage().rss;
      if (current > peakRss) {
        peakRss = current;
      }
    }, 20);

    const result = await postStreaming(
      serverPort,
      `/api/v1/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/large.bin')}`,
      LARGE_FILE_CHUNKS,
      CHUNK_SIZE,
    );

    clearInterval(samplingTimer);

    expect(result.status).toBe(201);
    expect(peakRss - baselineRss).toBeLessThan(MEMORY_GROWTH_LIMIT_BYTES);
  });

  it('업로드한 파일을 스트리밍으로 다운로드하면 내용이 동일하다', async () => {
    const namespaceId = await createNamespace('streaming-download-ns');
    // minio-js partSize(16MiB)보다 커야 실제로 여러 part로 나뉘어 업로드된다.
    // 40MiB(1MiB * 40)는 16MiB part 기준 3개 이상의 part로 나뉘므로, part 경계를
    // 넘나드는 멀티파트 업로드에서도 바이트가 손상되지 않는지 검증한다.
    const chunkCount = 40;
    const encodedPath = encodeURIComponent('/small.bin');

    await postStreaming(
      serverPort,
      `/api/v1/namespaces/${namespaceId}/fs/content?path=${encodedPath}`,
      chunkCount,
      CHUNK_SIZE,
    );

    const expectedHash = createHash('sha256');
    let expectedSize = 0;
    for (const chunk of generateChunks(chunkCount, CHUNK_SIZE)) {
      expectedHash.update(chunk);
      expectedSize += chunk.length;
    }

    const downloaded = await getStreamingHash(
      serverPort,
      `/api/v1/namespaces/${namespaceId}/fs/content?path=${encodedPath}`,
    );

    expect(downloaded.status).toBe(200);
    expect(downloaded.size).toBe(expectedSize);
    expect(downloaded.sha256).toBe(expectedHash.digest('hex'));
  });
});
