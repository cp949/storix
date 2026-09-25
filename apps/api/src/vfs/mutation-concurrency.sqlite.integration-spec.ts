import { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureBodyParsers } from '../common/body-parser.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { snapshotPost } from './vfs-snapshot-tree.test-support.js';
import { VfsModule } from './vfs.module.js';

// get만 실제 비동기 지연을 두는 메모리 스토리지다. 스냅샷 본문 조회는 트랜잭션 안에서
// storage.get을 기다리므로, 지연 동안 다른 요청이 같은 SQLite 연결로 끼어들 수 있다.
class SlowGetBlobStorage implements BlobStorage {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, stream: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    this.objects.set(key, Buffer.concat(chunks));
  }

  async get(key: string): Promise<Readable> {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const object = this.objects.get(key);
    if (!object) throw new Error(`object not found: ${key}`);
    return Readable.from([object]);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async *list(): AsyncIterable<{ key: string; lastModified: Date }> {}

  async getPresignedUrl(): Promise<string> {
    throw new Error('not supported');
  }
}

// SQLite 단일 연결에서 동시 요청의 트랜잭션·receipt claim이 서로 섞이지 않는지 HTTP 수준에서 확인한다.
// mkdir 계열은 blob storage를 쓰지 않으므로 컨테이너 없이 더미 스토리지 설정으로 앱을 띄운다.
describe('SQLite 동시 조건부 mutation HTTP', () => {
  let directory: string | undefined;
  let app: INestApplication;
  const storage = new SlowGetBlobStorage();
  const previous = { ...process.env };

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('Run with STORIX_DB_DRIVER=sqlite');
    directory = await mkdtemp(join(tmpdir(), 'storix-mutation-concurrency-'));
    process.env.STORIX_DB_SQLITE_PATH = join(directory, 'concurrency.sqlite');
    Object.assign(process.env, {
      STORIX_STORAGE_ENDPOINT: '127.0.0.1',
      STORIX_STORAGE_PORT: '1',
      STORIX_STORAGE_USE_SSL: 'false',
      STORIX_STORAGE_ACCESS_KEY: 'unused',
      STORIX_STORAGE_SECRET_KEY: 'unused-secret',
      STORIX_STORAGE_BUCKET: 'unused',
    });
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
      .overrideProvider(BLOB_STORAGE)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();
    await app.listen(0);
  }, 60000);

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  const http = () => request(app.getHttpServer());

  async function createNamespace(name: string): Promise<string> {
    const ns = await http()
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', randomUUID())
      .send({ name })
      .expect(201);
    return ns.body.id;
  }

  function mkdir(base: string, scope: string, key: string, path: string) {
    return http()
      .post(`${base}/mutations`)
      .set('X-Mutation-Scope', scope)
      .set('Idempotency-Key', key)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ kind: 'mkdir', path, ifAbsent: true }));
  }

  it('서로 다른 경로를 동시에 mkdir하면 전부 성공하고 전부 저장된다', async () => {
    const base = `/api/v1/namespaces/${await createNamespace('concurrent-distinct')}/fs`;
    const paths = Array.from({ length: 24 }, (_, i) => `/d${i}`);

    const results = await Promise.all(paths.map((path) => mkdir(base, 'distinct', randomUUID(), path)));

    expect(results.map((r) => r.status)).toEqual(paths.map(() => 201));
    const listed = await http().get(`${base}/ls`).query({ path: '/' }).expect(200);
    const names = (listed.body.items ?? listed.body).map((n: { name: string }) => n.name).sort();
    expect(names).toEqual(paths.map((p) => p.slice(1)).sort());
  });

  it('같은 경로를 동시에 mkdir하면 정확히 하나만 201이고 나머지는 결정적 4xx이며 다른 요청의 쓰기를 지우지 않는다', async () => {
    const base = `/api/v1/namespaces/${await createNamespace('concurrent-conflict')}/fs`;
    const paths = ['/same', '/x0', '/x1', '/x2'];
    const requests = [
      ...Array.from({ length: 6 }, () => mkdir(base, 'conflict', randomUUID(), '/same')),
      ...paths.slice(1).map((path) => mkdir(base, 'conflict', randomUUID(), path)),
    ];

    const results = await Promise.all(requests);

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(4);
    expect(statuses.filter((s) => s !== 201).every((s) => s >= 400 && s < 500)).toBe(true);
    const listed = await http().get(`${base}/ls`).query({ path: '/' }).expect(200);
    const names = (listed.body.items ?? listed.body).map((n: { name: string }) => n.name).sort();
    expect(names).toEqual(['same', 'x0', 'x1', 'x2']);
  });

  it('같은 Idempotency-Key를 동시에 보내도 하나만 실행되고 응답이 같다', async () => {
    const base = `/api/v1/namespaces/${await createNamespace('concurrent-replay')}/fs`;
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 8 }, () => mkdir(base, 'replay', key, '/once')));

    const done = results.filter((r) => r.status === 201);
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([201, 409]).toContain(r.status); // 409: 진행 중(MUTATION_IN_PROGRESS)
    const listed = await http().get(`${base}/ls`).query({ path: '/' }).expect(200);
    expect((listed.body.items ?? listed.body).map((n: { name: string }) => n.name)).toEqual(['once']);
  });

  it('조건부 content 요청의 오류 receipt 확정 중 namespace가 삭제되면 404를 반환한다', async () => {
    const namespaceId = await createNamespace('concurrent-error-receipt-delete');
    const receipts = app.get(VfsMutationReceiptRepository);
    const completeAfterRollback = receipts.completeAfterRollback.bind(receipts);
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const completionSpy = jest
      .spyOn(receipts, 'completeAfterRollback')
      .mockImplementation(async (...args) => {
        enteredResolve();
        await released;
        await completeAfterRollback(...args);
      });

    try {
      const responsePromise = http()
        .post(`/api/v1/namespaces/${namespaceId}/fs/content/conditional`)
        .query({ path: '/file' })
        .set('Content-Type', 'application/octet-stream')
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'namespace-delete-race')
        .send(Buffer.from('body'))
        .then((response) => response);

      await entered;
      const dataSource = app.get(DataSource);
      await dataSource.query('DELETE FROM vfs_node WHERE namespace_id = ?', [namespaceId]);
      await dataSource.getRepository(NamespaceEntity).delete(namespaceId);
      releaseResolve();

      const response = await responsePromise;
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NAMESPACE_NOT_FOUND');
    } finally {
      releaseResolve();
      completionSpy.mockRestore();
    }
  });

  it('스냅샷 본문 조회가 트랜잭션 안에서 스토리지를 기다리다 실패해도 그동안 들어온 mkdir 요청이 유실되지 않는다', async () => {
    const base = `/api/v1/namespaces/${await createNamespace('concurrent-snapshot-read')}/fs`;
    const put = (path: string, body: string) =>
      http()
        .post(`${base}/content`)
        .query({ path })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(body))
        .expect(201);
    await put('/file', 'snapshot-body');
    await put('/gone', 'gone-body');
    const contentUrl = async (path: string) => {
      const snapshot = await snapshotPost(app, base, '', { kind: 'file', path }, randomUUID()).expect(201);
      return `${base}/snapshots/${snapshot.body.snapshotId}/content`;
    };
    const okUrl = await contentUrl('/file');
    const goneUrl = await contentUrl('/gone');
    // 저장소에서 객체가 사라진 상황: storage.get이 지연된 뒤 실패해 트랜잭션이 늦게 롤백된다
    for (const [key, body] of storage.objects) if (body.toString() === 'gone-body') storage.objects.delete(key);
    const paths = Array.from({ length: 8 }, (_, i) => `/m${i}`);
    // 같은 경로를 여러 번 보내 일부 트랜잭션이 결정적 4xx로 롤백되게 한다
    const duplicates = Array.from({ length: 4 }, () => '/dup');

    const [okReads, goneReads, writes] = await Promise.all([
      Promise.all(Array.from({ length: 4 }, () => http().get(okUrl))),
      Promise.all(Array.from({ length: 4 }, () => http().get(goneUrl))),
      Promise.all([...paths, ...duplicates].map((path) => mkdir(base, 'snapshot-read', randomUUID(), path))),
    ]);

    expect(okReads.map((r) => r.status)).toEqual(okReads.map(() => 200));
    expect(goneReads.map((r) => r.status)).toEqual(goneReads.map(() => 500));
    const statuses = writes.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(paths.length + 1);
    expect(statuses.filter((s) => s !== 201).every((s) => s >= 400 && s < 500)).toBe(true);
    const listed = await http().get(`${base}/ls`).query({ path: '/' }).expect(200);
    const names = (listed.body.items ?? listed.body).map((n: { name: string }) => n.name).sort();
    expect(names).toEqual(['dup', 'file', 'gone', ...paths.map((p) => p.slice(1))].sort());
  });
});
