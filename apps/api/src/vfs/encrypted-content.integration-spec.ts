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

const MASTER_KEY_HEX = 'ab'.repeat(32);

describe('ENCRYPTED namespace 콘텐츠 암복호화', () => {
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
    process.env.STORIX_STORAGE_BUCKET = 'storix-encryption-test';
    process.env.STORIX_MAX_FILE_SIZE_BYTES = String(1024 * 1024 * 1024);
    process.env.STORIX_MAX_SYNC_DELETE_NODES = '1000';
    process.env.STORIX_MAX_SYNC_COPY_NODES = '1000';
    process.env.STORIX_ENCRYPTION_MASTER_KEY = MASTER_KEY_HEX;

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

  async function createEncryptedNamespace(name: string): Promise<string> {
    const response = await request(httpServer)
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', `ns-${name}`)
      .send({ name, encryptionPolicy: 'ENCRYPTED' })
      .expect(201);

    expect(response.body.encryptionPolicy).toBe('ENCRYPTED');
    return response.body.id;
  }

  async function readRawStoredObject(namespaceId: string, path: string): Promise<{ raw: Buffer; iv: Buffer | null }> {
    const rows = await migrationDataSource.query(
      `SELECT b.storage_key, b.encryption_iv
       FROM vfs_node vn JOIN blob b ON b.id = vn.blob_id
       WHERE vn.namespace_id = $1 AND vn.name = $2`,
      [namespaceId, path],
    );
    const stream = await minioClient.getObject(process.env.STORIX_STORAGE_BUCKET as string, rows[0].storage_key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return { raw: Buffer.concat(chunks), iv: rows[0].encryption_iv };
  }

  it('저장된 오브젝트는 평문과 다른 바이트이고, IV가 기록된다', async () => {
    const namespaceId = await createEncryptedNamespace(`enc-raw-${randomUUID()}`);
    const plaintext = '0123456789'.repeat(10);

    await request(httpServer)
      .post(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/secret.txt' })
      .set('Content-Type', 'text/plain')
      .send(plaintext)
      .expect(201);

    const { raw, iv } = await readRawStoredObject(namespaceId, 'secret.txt');

    expect(raw).not.toEqual(Buffer.from(plaintext));
    expect(raw.length).toBe(Buffer.byteLength(plaintext));
    expect(iv).not.toBeNull();
  });

  it('전체 다운로드는 원문과 동일하다', async () => {
    const namespaceId = await createEncryptedNamespace(`enc-full-${randomUUID()}`);
    const plaintext = 'a'.repeat(5000);

    await request(httpServer)
      .post(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/full.txt' })
      .set('Content-Type', 'text/plain')
      .send(plaintext)
      .expect(201);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/full.txt' })
      .expect(200);

    expect(response.text).toBe(plaintext);
  });

  it('블록 경계에 정렬되지 않은 Range 요청도 올바른 구간을 복호화해 반환한다', async () => {
    const namespaceId = await createEncryptedNamespace(`enc-range-${randomUUID()}`);
    const plaintext = Array.from({ length: 5000 }, (_, i) => String(i % 10)).join('');

    await request(httpServer)
      .post(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/range.txt' })
      .set('Content-Type', 'text/plain')
      .send(plaintext)
      .expect(201);

    const response = await request(httpServer)
      .get(`/api/v1/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/range.txt' })
      .set('Range', 'bytes=10-4009')
      .expect(206);

    expect(response.headers['content-range']).toBe('bytes 10-4009/5000');
    expect(response.text).toBe(plaintext.slice(10, 4010));
  });

  // EncryptionBootGuard 단위 테스트는 가드를 직접 new 해서 검증하므로, 가드가
  // EncryptionModule providers에서 빠지거나 EncryptionModule이 모듈 그래프에서
  // 끊겨도 잡히지 않는다. 실제 앱과 동일한 모듈 구성으로 부팅시켜 배선을 검증한다.
  it('ENCRYPTED namespace가 있는데 마스터 키가 없으면 앱 부팅이 실패한다', async () => {
    await createEncryptedNamespace(`enc-boot-${randomUUID()}`);

    // 같은 프로세스에서 이어지는 테스트들이 마스터 키를 필요로 하므로 반드시 복구한다.
    delete process.env.STORIX_ENCRYPTION_MASTER_KEY;
    let guardedApp: INestApplication | undefined;

    try {
      // 모듈 배선 자체는 성공해야 한다 — 실패는 부팅 훅에서만 일어난다.
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule, VfsModule],
      }).compile();
      guardedApp = moduleRef.createNestApplication({ bodyParser: false });

      await expect(guardedApp.init()).rejects.toThrow(/ENCRYPTED namespace/);
    } finally {
      process.env.STORIX_ENCRYPTION_MASTER_KEY = MASTER_KEY_HEX;
      await guardedApp?.close().catch(() => undefined);
    }
  }, 60000);
});
