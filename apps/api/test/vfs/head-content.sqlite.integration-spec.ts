import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { MASTER_KEY } from '../../src/encryption/encryption.constants.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import { snapshotPost } from './vfs-snapshot-tree.test-support.js';

const BODY = 'head-request-body';

// HEAD가 본문을 읽지 않는지 실제 SQLite + S3 어댑터에서 확인한다. 라우트 5개가 같은 sendContent를 쓴다.
describe('HEAD 요청은 Blob을 읽지 않는다 (SQLite + S3)', () => {
  let container: StartedS3Container | undefined;
  let directory: string | undefined;
  let app: INestApplication;
  let getSpy: jest.SpiedFunction<BlobStorage['get']>;
  const previous = { ...process.env };

  const http = () => request(app.getHttpServer());

  async function createNamespace(extra: Record<string, unknown> = {}): Promise<string> {
    const response = await http()
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', randomUUID())
      .send({ name: randomUUID(), ...extra })
      .expect(201);
    return response.body.id as string;
  }

  async function upload(namespaceId: string, path: string): Promise<void> {
    await http()
      .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
      .query({ path })
      .set('Content-Type', 'text/plain')
      .send(BODY)
      .expect(201);
  }

  // GET과 HEAD를 같은 URL에 보내 헤더가 같고 HEAD는 본문이 없으며 HEAD가 storage.get을 부르지 않았는지 확인한다.
  async function expectHeadMatchesGet(url: string, headers: Record<string, string> = {}, status = 200) {
    const get = await http().get(url).set(headers).buffer(true).expect(status);
    const callsAfterGet = getSpy.mock.calls.length;
    const head = await http().head(url).set(headers).expect(status);

    expect(getSpy.mock.calls.length).toBe(callsAfterGet);
    expect(head.text ?? '').toBe('');
    for (const name of [
      'content-length',
      'content-type',
      'content-range',
      'content-disposition',
      'content-security-policy',
      'x-content-type-options',
      'accept-ranges',
      'x-storix-file-id',
      'x-storix-revision',
      'x-storix-sha256',
      'x-storix-snapshot-id',
    ]) {
      expect(head.headers[name]).toBe(get.headers[name]);
    }
    return { get, head };
  }

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('Run with STORIX_DB_DRIVER=sqlite');
    directory = await mkdtemp(join(tmpdir(), 'storix-head-http-'));
    process.env.STORIX_DB_SQLITE_PATH = join(directory, 'head.sqlite');
    container = await startS3Container();
    Object.assign(process.env, {
      STORIX_STORAGE_ENDPOINT: container.getHost(),
      STORIX_STORAGE_PORT: String(container.getPort()),
      STORIX_STORAGE_USE_SSL: 'false',
      STORIX_STORAGE_ACCESS_KEY: container.getUsername(),
      STORIX_STORAGE_SECRET_KEY: container.getPassword(),
      STORIX_STORAGE_BUCKET: 'head-sqlite',
    });
    await createTestBucket(createTestS3Client(container), 'head-sqlite');
    const migration = new DataSource({
      type: 'better-sqlite3',
      database: process.env.STORIX_DB_SQLITE_PATH,
      migrations: ALL_MIGRATIONS,
      migrationsTransactionMode: 'each',
    });
    try {
      await migration.initialize();
      await migration.runMigrations();
    } finally {
      if (migration.isInitialized) await migration.destroy();
    }
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
    getSpy = jest.spyOn(app.get<BlobStorage>(BLOB_STORAGE), 'get');
  }, 180000);

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      try {
        if (container) await container.stop();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    }
  });

  it('인증 경로 content·download의 HEAD는 GET과 같은 헤더를 내고 Blob을 읽지 않는다', async () => {
    const namespaceId = await createNamespace();
    await upload(namespaceId, '/a.txt');
    const base = `/api/v2/namespaces/${namespaceId}/fs`;

    const { head } = await expectHeadMatchesGet(`${base}/content?path=/a.txt`);
    expect(head.headers['content-length']).toBe(String(BODY.length));
    expect(head.headers['x-storix-sha256']).toBeDefined();
    const download = await expectHeadMatchesGet(`${base}/download?path=/a.txt`);
    expect(download.head.headers['content-disposition']).toContain('attachment');
  });

  it('Range가 있는 HEAD는 206과 Content-Range를 내고 잘못된 범위는 416이다', async () => {
    const namespaceId = await createNamespace();
    await upload(namespaceId, '/a.txt');
    const url = `/api/v2/namespaces/${namespaceId}/fs/content?path=/a.txt`;

    const { head } = await expectHeadMatchesGet(url, { Range: 'bytes=2-5' }, 206);
    expect(head.headers['content-range']).toBe(`bytes 2-5/${BODY.length}`);
    expect(head.headers['content-length']).toBe('4');
    await http().head(url).set('Range', 'bytes=999-1000').expect(416);
  });

  it('ENCRYPTED namespace의 HEAD도 평문 길이를 내고 Blob을 읽지 않는다', async () => {
    const namespaceId = await createNamespace({ encryptionPolicy: 'ENCRYPTED' });
    await upload(namespaceId, '/a.txt');

    const { head } = await expectHeadMatchesGet(`/api/v2/namespaces/${namespaceId}/fs/content?path=/a.txt`);
    expect(head.headers['content-length']).toBe(String(BODY.length));
  });

  it('공개 경로 content·download의 HEAD도 Blob을 읽지 않고, 공개되지 않은 namespace는 GET과 같이 404다', async () => {
    const publicId = await createNamespace({ accessPolicy: 'PUBLIC' });
    await upload(publicId, '/a.txt');
    const privateId = await createNamespace();
    await upload(privateId, '/a.txt');

    await expectHeadMatchesGet(`/api/v2/public/${publicId}/fs/content?path=/a.txt`);
    await expectHeadMatchesGet(`/api/v2/public/${publicId}/fs/download?path=/a.txt`);
    await http().head(`/api/v2/public/${privateId}/fs/content?path=/a.txt`).expect(404);
  });

  it('snapshot content의 HEAD도 Blob을 읽지 않는다', async () => {
    const namespaceId = await createNamespace();
    await upload(namespaceId, '/a.txt');
    const base = `/api/v2/namespaces/${namespaceId}/fs`;
    const snapshot = await snapshotPost(app, base, '', { kind: 'file', path: '/a.txt' }).expect(201);
    const url = `${base}/snapshots/${snapshot.body.snapshotId}/content`;

    const { head } = await expectHeadMatchesGet(url);
    expect(head.headers['content-length']).toBe(String(BODY.length));
    await expectHeadMatchesGet(url, { Range: 'bytes=0-3' }, 206);
  });
});
