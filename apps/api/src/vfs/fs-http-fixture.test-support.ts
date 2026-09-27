import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient } from 'minio';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureBodyParsers } from '../common/body-parser.js';
import { DomainError } from '../common/domain-error.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { VfsMutationReceiptEntity } from '../persistence/entities/vfs-mutation-receipt.entity.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { VfsModule } from './vfs.module.js';

export const MAX_FILE_SIZE_BYTES = 1048576;

export function withoutStatHash(stat: Record<string, unknown>): Record<string, unknown> {
  const current = { ...stat };
  delete current.sha256;
  return current;
}

// 저장하지 않는 5xx DomainError를 주입하기 위한 테스트 전용 오류
export class InjectedUnavailableError extends DomainError {
  readonly code = 'INJECTED_UNAVAILABLE';
  readonly status = 503;

  constructor() {
    super('injected unavailable');
  }
}

export function postChunked(
  port: number,
  path: string,
  chunks: Buffer[],
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...extraHeaders },
      },
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

export function startHeldUpload(
  port: number,
  path: string,
  headers: Record<string, string>,
): {
  req: ReturnType<typeof httpRequest>;
  response: Promise<{ status: number; body: unknown; headers: IncomingHttpHeaders }>;
} {
  let resolveResponse!: (value: { status: number; body: unknown; headers: IncomingHttpHeaders }) => void;
  let rejectResponse!: (reason: unknown) => void;
  const response = new Promise<{ status: number; body: unknown; headers: IncomingHttpHeaders }>(
    (resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    },
  );
  const req = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...headers },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveResponse({
          status: res.statusCode ?? 0,
          body: text ? JSON.parse(text) : null,
          headers: res.headers,
        });
      });
    },
  );
  req.on('error', rejectResponse);
  return { req, response };
}

export function createFsHttpFixture() {
  const previousCapabilityConfigPath = process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
  let postgresContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let serverPort: number;

  async function bootstrap() {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule, VfsModule],
    })
      .overrideProvider(MASTER_KEY)
      .useValue(Buffer.from('ab'.repeat(32), 'hex'))
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();
    await app.listen(0);
    httpServer = app.getHttpServer();
    serverPort = (httpServer.address() as { port: number }).port;
  }

  beforeAll(async () => {
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
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
    process.env.STORIX_STORAGE_BUCKET = 'storix-fs-test';
    process.env.STORIX_MAX_FILE_SIZE_BYTES = String(MAX_FILE_SIZE_BYTES);
    process.env.STORIX_MAX_SYNC_DELETE_NODES = '5';
    process.env.STORIX_MAX_SYNC_COPY_NODES = '5';

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

    await bootstrap();
  }, 180000);

  afterAll(async () => {
    await app.close();
    await migrationDataSource.destroy();
    await postgresContainer.stop();
    await minioContainer.stop();
    if (previousCapabilityConfigPath === undefined) delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    else process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH = previousCapabilityConfigPath;
  });

  async function createNamespace(name: string): Promise<string> {
    const response = await request(httpServer)
      .post('/api/v2/namespaces')
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

  return {
    get app() {
      return app;
    },
    get httpServer() {
      return httpServer;
    },
    get migrationDataSource() {
      return migrationDataSource;
    },
    get serverPort() {
      return serverPort;
    },
    bootstrap,
    createNamespace,
    createFileDirectly,
  };
}

export type FsHttpContext = ReturnType<typeof createFsHttpFixture>;
