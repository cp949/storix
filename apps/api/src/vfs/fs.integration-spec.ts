import { snapshotPost as treePost, treeSnapshotContract } from './vfs-snapshot-tree.test-support.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { VfsSnapshotEntity } from '../persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../persistence/entities/vfs-snapshot-entry.entity.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { once } from 'node:events';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as MinioClient, S3Error } from 'minio';
import request from 'supertest';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { configureBodyParsers } from '../common/body-parser.js';
import { DomainError } from '../common/domain-error.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { VfsMutationReceiptEntity } from '../persistence/entities/vfs-mutation-receipt.entity.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsSnapshotRepository } from '../persistence/vfs-snapshot.repository.js';
import { BLOB_STORAGE, STORAGE_CLIENT } from '../storage/storage.constants.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { VfsModule } from './vfs.module.js';
import { decodeRevision, encodeRevision } from './revision.js';

const MAX_FILE_SIZE_BYTES = 1048576;

function withoutStatHash(stat: Record<string, unknown>): Record<string, unknown> {
  const current = { ...stat };
  delete current.sha256;
  return current;
}

// 저장하지 않는 5xx DomainError를 주입하기 위한 테스트 전용 오류
class InjectedUnavailableError extends DomainError {
  readonly code = 'INJECTED_UNAVAILABLE';
  readonly status = 503;

  constructor() {
    super('injected unavailable');
  }
}

function postChunked(
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

function startHeldUpload(
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

describe('Fs HTTP contract', () => {
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

  treeSnapshotContract(() => app);

  it('긴 유효 경로의 TREE manifest를 저장하고 끝 항목까지 조회한다', async () => {
    const ns = await createNamespace('snapshot-long-path');
    const base = `/api/v2/namespaces/${ns}/fs`;
    let path = '';
    for (let i = 0; i < 16; i++) {
      path += `/${randomBytes(135).toString('base64url')}`;
      await request(httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
    }
    expect(Buffer.byteLength(path)).toBeGreaterThan(2704);

    const captured = await treePost(app, base, '', { kind: 'tree', path: '/' }).expect(201);
    const page = await request(httpServer)
      .get(`${base}/snapshots/${captured.body.snapshotId}/entries`)
      .query({ limit: 100 })
      .expect(200);
    expect(page.body.items).toHaveLength(17);
    expect(page.body.items.at(-1).relativePath).toBe(path.slice(1));
    expect(page.body.nextCursor).toBeNull();
  });

  it.each(['snapshot', 'writer'] as const)(
    'TREE capture vs writer: PostgreSQL %s 선행은 완전한 한 시점만 고정한다',
    async (first) => {
      const ns = await createNamespace(`tree-race-${first}`);
      const base = `/api/v2/namespaces/${ns}/fs`;
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/old' }).expect(201);
      for (const name of ['a', 'b'])
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path: `/old/${name}` })
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(name))
          .expect(201);
      const before = (await request(httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200))
        .body;
      const holder = migrationDataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
      await holder.query('SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE', [
        ns,
      ]);
      const pending: Promise<request.Response>[] = [];
      let completed = 0;
      const start = (operation: 'snapshot' | 'writer') => {
        const req =
          operation === 'snapshot'
            ? treePost(app, base, '', { kind: 'tree', path: '/' })
            : request(httpServer).post(`${base}/mv`).send({ source: '/old', destination: '/new' });
        pending.push(
          req.then((response) => {
            completed++;
            return response;
          }),
        );
      };
      const blocked = async (count: number) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const rows = await migrationDataSource.query(
            'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0',
            [holderPid],
          );
          if (rows.length >= count) {
            expect(new Set(rows.map((row: { pid: number }) => row.pid)).size).toBe(count);
            return;
          }
          if (completed) throw new Error('operation completed before root lock release');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`expected ${count} separate PostgreSQL waiters`);
      };
      try {
        start(first);
        await blocked(1);
        start(first === 'snapshot' ? 'writer' : 'snapshot');
        await blocked(2);
      } finally {
        await holder.commitTransaction();
        await holder.release();
        await Promise.all(pending);
      }
      const results = await Promise.all(pending);
      const captured = results[first === 'snapshot' ? 0 : 1];
      const writer = results[first === 'writer' ? 0 : 1];
      expect(captured.status).toBe(201);
      expect(writer.status).toBe(200);
      const after = (await request(httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200)).body;
      expect(after.revision).not.toBe(before.revision);
      expect(captured.body.sourceRevision).toBe(first === 'snapshot' ? before.revision : after.revision);
      const page = (
        await request(httpServer).get(`${base}/snapshots/${captured.body.snapshotId}/entries`).expect(200)
      ).body;
      expect(page.items.map((item: { relativePath: string }) => item.relativePath)).toEqual(
        first === 'snapshot' ? ['.', 'old', 'old/a', 'old/b'] : ['.', 'new', 'new/a', 'new/b'],
      );
      expect(page.items[0].sourceRevision).toBe(captured.body.sourceRevision);
      for (const item of page.items.filter((item: { type: string }) => item.type === 'FILE')) {
        expect((await request(httpServer).get(item.contentPath).expect(200)).body).toEqual(
          Buffer.from(item.relativePath.endsWith('/a') ? 'a' : 'b'),
        );
      }
    },
  );

  describe('FILE snapshots', () => {
    const scope = 'snapshot-http';
    function snapshotPost(base: string, suffix: string, key: string, body: string) {
      return request(httpServer)
        .post(`${base}/snapshots${suffix}`)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', scope)
        .send(body);
    }

    it('snapshot 생성의 분류된 DB 일시·영구 실패는 HTTP 코드와 receipt 비저장 계약을 지킨다', async () => {
      const namespaceId = await createNamespace('snapshot-storage-failure-http');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/source' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('snapshot source'))
        .expect(201);
      const repository = app.get(VfsSnapshotRepository);
      const receipts = migrationDataSource.getRepository(VfsMutationReceiptEntity);
      const snapshots = app.get(DataSource).getRepository(VfsSnapshotEntity);
      const body = '{"kind":"file","path":"/source"}';
      const transientKey = randomUUID();
      const transientSpy = jest.spyOn(repository, 'capture').mockRejectedValueOnce({
        driverError: { code: '08006', message: 'private database endpoint' },
      });
      try {
        const unavailable = await snapshotPost(base, '', transientKey, body).expect(503);
        expect(unavailable.body.code).toBe('STORAGE_UNAVAILABLE');
        expect(JSON.stringify(unavailable.body)).not.toContain('private database endpoint');
        expect(await receipts.findOneBy({ namespaceId, scope, idempotencyKey: transientKey })).toBeNull();
        expect(await snapshots.countBy({ namespaceId })).toBe(0);
      } finally {
        transientSpy.mockRestore();
      }

      const created = await snapshotPost(base, '', transientKey, body).expect(201);
      const replay = await snapshotPost(base, '', transientKey, body).expect(201);
      expect(replay.body).toEqual(created.body);
      expect(await receipts.findOneBy({ namespaceId, scope, idempotencyKey: transientKey }))
        .toMatchObject({ state: 'COMPLETE' });
      expect(await snapshots.countBy({ namespaceId })).toBe(1);

      const permanentKey = randomUUID();
      const permanentSpy = jest.spyOn(repository, 'capture').mockRejectedValueOnce({
        driverError: { code: '53100', message: 'private disk path' },
      });
      try {
        const failure = await snapshotPost(base, '', permanentKey, body).expect(500);
        expect(failure.body.code).toBe('STORAGE_FAILURE');
        expect(JSON.stringify(failure.body)).not.toContain('private disk path');
        expect(await receipts.findOneBy({ namespaceId, scope, idempotencyKey: permanentKey })).toBeNull();
        expect(await snapshots.countBy({ namespaceId })).toBe(1);
      } finally {
        permanentSpy.mockRestore();
      }
    });

    it('파일별 목록은 node ID에 묶이고 cursor를 검증한다', async () => {
      const ns = await createNamespace('file-snapshot-list');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from('snapshot-list');
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/a' })
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(201);
      const source = (await request(httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200)).body;
      const captured = await snapshotPost(
        base,
        '',
        randomUUID(),
        JSON.stringify({ kind: 'file', path: '/a' }),
      ).expect(201);
      const page = (
        await request(httpServer).get(`${base}/snapshots`).query({ rootNodeId: source.id }).expect(200)
      ).body;
      expect(page.items).toEqual([
        expect.objectContaining({
          snapshotId: captured.body.snapshotId,
          sourceRevision: captured.body.sourceRevision,
          logicalBytes: String(bytes.length),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
      ]);
      expect(page.nextCursor).toBeNull();
      await request(httpServer).post(`${base}/mv`).send({ source: '/a', destination: '/moved' }).expect(200);
      const movedStat = (await request(httpServer).get(`${base}/stat`).query({ path: '/moved' }).expect(200))
        .body;
      expect(movedStat.id).toBe(source.id);
      const afterMove = (
        await request(httpServer).get(`${base}/snapshots`).query({ rootNodeId: source.id }).expect(200)
      ).body;
      expect(afterMove.items).toEqual(page.items);

      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/a' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('replacement'))
        .expect(201);
      const replacement = (await request(httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200))
        .body;
      expect(replacement.id).not.toBe(source.id);
      const originalNodeSnapshots = (
        await request(httpServer).get(`${base}/snapshots`).query({ rootNodeId: source.id }).expect(200)
      ).body;
      const replacementNodeSnapshots = (
        await request(httpServer).get(`${base}/snapshots`).query({ rootNodeId: replacement.id }).expect(200)
      ).body;
      expect(originalNodeSnapshots.items).toEqual(page.items);
      expect(replacementNodeSnapshots.items).toEqual([]);
      await request(httpServer)
        .get(`${base}/snapshots`)
        .query({ rootNodeId: randomUUID(), cursor: 'sl1.bogus' })
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VFS_INVALID_CURSOR'));
      await request(httpServer)
        .get(`${base}/snapshots`)
        .query({ rootNodeId: 'bad' })
        .expect(400)
        .expect(({ body }) => expect(body.code).toBe('VFS_INVALID_MUTATION_REQUEST'));
    });

    async function restoreFixture(name: string) {
      const ns = await createNamespace(name);
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from([0, 255, 128, 65]);
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/source' })
        .set('Content-Type', 'Application/Octet-Stream; ignored=value')
        .send(bytes)
        .expect(201);
      const captured = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/source"}').expect(
        201,
      );
      const blob = await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns });
      return { ns, base, bytes, blob, id: captured.body.snapshotId as string };
    }

    it('PostgreSQL 앱 재시작 후 TREE/FILE bytes, cursor, restore와 완료 receipt를 유지한다', async () => {
      const ns = await createNamespace('snapshot-pg-restart');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from([0, 255, 128, 65]);
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/dir/a' })
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(201);
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/dir/b' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('other'))
        .expect(201);
      const treeKey = randomUUID();
      const treeBody = '{"kind":"tree","path":"/dir"}';
      const tree = await snapshotPost(base, '', treeKey, treeBody).expect(201);
      const firstPage = (
        await request(httpServer)
          .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
          .query({ limit: 2 })
          .expect(200)
      ).body;
      const secondPage = (
        await request(httpServer)
          .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
          .query({ limit: 2, cursor: firstPage.nextCursor })
          .expect(200)
      ).body;
      const fileKey = randomUUID();
      const fileBody = '{"kind":"file","path":"/dir/a"}';
      const file = await snapshotPost(base, '', fileKey, fileBody).expect(201);
      const restoreKey = randomUUID();
      const restoreBody = '{"path":"/restored","ifAbsent":true}';
      const restored = await snapshotPost(
        base,
        `/${file.body.snapshotId}/restore`,
        restoreKey,
        restoreBody,
      ).expect(201);
      const disposable = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/dir/b"}').expect(
        201,
      );
      const deleteKey = randomUUID();
      const deleteSuffix = `/${disposable.body.snapshotId}/delete`;
      const deleted = await snapshotPost(base, deleteSuffix, deleteKey, '{}').expect(200);
      await request(httpServer).post(`${base}/rm`).query({ path: '/dir', recursive: true }).expect(204);

      const oldDataSource = app.get(DataSource);
      await app.close();
      expect(oldDataSource.isInitialized).toBe(false);
      await bootstrap();
      expect(app.get(DataSource)).not.toBe(oldDataSource);
      expect(
        (await request(httpServer).get(`${base}/snapshots/${tree.body.snapshotId}`).expect(200)).body,
      ).toEqual(tree.body);
      expect(
        (await request(httpServer).get(`${base}/snapshots/${file.body.snapshotId}`).expect(200)).body,
      ).toEqual(file.body);
      expect(
        (
          await request(httpServer)
            .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
            .query({ limit: 2 })
            .expect(200)
        ).body,
      ).toEqual(firstPage);
      expect(
        (
          await request(httpServer)
            .get(`${base}/snapshots/${tree.body.snapshotId}/entries`)
            .query({ limit: 2, cursor: firstPage.nextCursor })
            .expect(200)
        ).body,
      ).toEqual(secondPage);
      for (const url of [
        `${base}/snapshots/${file.body.snapshotId}/content`,
        `${base}/snapshots/${tree.body.snapshotId}/content?path=a`,
        `${base}/content?path=/restored`,
      ])
        expect((await request(httpServer).get(url).expect(200)).body).toEqual(bytes);
      for (const [suffix, body, key, original] of [
        ['', treeBody, treeKey, tree],
        ['', fileBody, fileKey, file],
        [`/${file.body.snapshotId}/restore`, restoreBody, restoreKey, restored],
        [deleteSuffix, '{}', deleteKey, deleted],
      ] as const) {
        const replay = await snapshotPost(base, suffix, key, body).expect(original.status);
        expect(replay.body).toEqual(original.body);
        expect(replay.headers['x-request-id']).toBe(original.headers['x-request-id']);
      }
      await snapshotPost(
        base,
        `/${file.body.snapshotId}/restore`,
        randomUUID(),
        '{"path":"/after-restart","ifAbsent":true}',
      ).expect(201);
      const restartedContent = await request(httpServer)
        .get(`${base}/content`)
        .query({ path: '/after-restart' })
        .expect(200);
      const restartedStat = await request(httpServer)
        .get(`${base}/stat`)
        .query({ path: '/after-restart' })
        .expect(200);
      expect(restartedContent.body).toEqual(bytes);
      expect(restartedContent.headers['x-storix-file-id']).toBe(restartedStat.body.id);
      expect(restartedContent.headers['x-storix-revision']).toBe(restartedStat.body.revision);
      expect(restartedContent.headers['x-storix-sha256']).toBe(restartedStat.body.sha256);
      expect(restartedContent.headers['x-storix-sha256']).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      await request(httpServer).get(`${base}/snapshots/${disposable.body.snapshotId}`).expect(404);
    });

    it('조건부 JSON mutation과 raw upload receipt를 PostgreSQL 앱 재시작 후 재생한다', async () => {
      const ns = await createNamespace('conditional-mutation-pg-restart');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const jsonKey = randomUUID();
      const jsonBody = '{"kind":"mkdir","path":"/receipt-dir","ifAbsent":true}';
      const sendJson = () =>
        request(httpServer)
          .post(`${base}/mutations`)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', jsonKey)
          .set('X-Mutation-Scope', 'restart-contract')
          .send(jsonBody);
      const jsonResult = await sendJson().expect(201);
      const uploadKey = randomUUID();
      const uploadBytes = Buffer.from([0, 255, 128, 65]);
      const sendUpload = () =>
        request(httpServer)
          .post(`${base}/content/conditional`)
          .query({ path: '/receipt-dir/file.bin' })
          .set('Content-Type', 'application/octet-stream')
          .set('Idempotency-Key', uploadKey)
          .set('X-Mutation-Scope', 'restart-contract')
          .set('X-If-Absent', 'true')
          .send(uploadBytes);
      const uploadResult = await sendUpload().expect(201);
      const blobCount = await migrationDataSource
        .getRepository(BlobEntity)
        .count({ where: { namespaceId: ns } });

      const oldDataSource = app.get(DataSource);
      await app.close();
      expect(oldDataSource.isInitialized).toBe(false);
      await bootstrap();
      expect(app.get(DataSource)).not.toBe(oldDataSource);

      const replayedJson = await sendJson().expect(201);
      expect(replayedJson.body).toEqual(jsonResult.body);
      expect(replayedJson.headers['x-request-id']).toBe(jsonResult.headers['x-request-id']);
      const replayedUpload = await sendUpload().expect(201);
      expect(replayedUpload.body).toEqual(uploadResult.body);
      expect(replayedUpload.headers['x-request-id']).toBe(uploadResult.headers['x-request-id']);
      expect(await migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId: ns } })).toBe(
        blobCount,
      );
      expect(
        (
          await request(httpServer)
            .get(`${base}/content`)
            .query({ path: '/receipt-dir/file.bin' })
            .expect(200)
        ).body,
      ).toEqual(uploadBytes);
    });

    it('FILE metadata 읽기 중 snapshot 삭제가 끝나도 캡처된 해시를 반환한다', async () => {
      const ns = await createNamespace('snapshot-file-metadata-delete-race');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from('metadata-race');
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/source' })
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(201);
      const captured = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/source"}').expect(
        201,
      );
      const repository = app.get(VfsSnapshotRepository);
      type HashReader = (manager: EntityManager, snapshot: VfsSnapshotEntity) => Promise<string | null>;
      const original = (Reflect.get(repository, 'fileSha256') as HashReader).bind(repository);
      let entered!: () => void;
      let release!: () => void;
      const readEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = jest
        .spyOn(repository as unknown as { fileSha256: HashReader }, 'fileSha256')
        .mockImplementation(async (manager, snapshot) => {
          entered();
          await held;
          return original(manager, snapshot);
        });
      const pending = repository.get(ns, captured.body.snapshotId as string);
      try {
        await readEntered;
        await snapshotPost(base, `/${captured.body.snapshotId}/delete`, randomUUID(), '{}').expect(200);
        release();
        await expect(pending).resolves.toMatchObject({
          id: captured.body.snapshotId,
          rootNodeId: captured.body.rootNodeId,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it.each([
      { writer: 'overwrite', first: 'snapshot' },
      { writer: 'overwrite', first: 'writer' },
      { writer: 'delete', first: 'snapshot' },
      { writer: 'delete', first: 'writer' },
    ] as const)(
      'FILE capture vs $writer: PostgreSQL $first 선행은 한 시점만 고정한다',
      async ({ writer, first }) => {
        const ns = await createNamespace(`snapshot-file-race-${writer}-${first}`);
        const base = `/api/v2/namespaces/${ns}/fs`;
        const oldBytes = Buffer.from([0, 255, 65]);
        const newBytes = Buffer.from([128, 66, 67]);
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path: '/race' })
          .set('Content-Type', 'application/octet-stream')
          .send(oldBytes)
          .expect(201);
        const before = (
          await request(httpServer).get(`${base}/revision`).query({ path: '/race' }).expect(200)
        ).body;
        const holder = migrationDataSource.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
        await holder.query(
          'SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE',
          [ns],
        );
        const pending: Promise<request.Response>[] = [];
        let completed = 0;
        const start = (operation: 'snapshot' | 'writer') => {
          const req =
            operation === 'snapshot'
              ? snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/race"}')
              : writer === 'overwrite'
                ? request(httpServer)
                    .post(`${base}/content`)
                    .query({ path: '/race', force: true })
                    .set('Content-Type', 'application/octet-stream')
                    .send(newBytes)
                : request(httpServer).post(`${base}/rm`).query({ path: '/race' });
          pending.push(
            req.then((response) => {
              completed++;
              return response;
            }),
          );
        };
        const blocked = async (count: number) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const rows = await migrationDataSource.query(
              'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0',
              [holderPid],
            );
            if (rows.length >= count) {
              expect(new Set(rows.map((row: { pid: number }) => row.pid)).size).toBe(count);
              return;
            }
            if (completed) throw new Error('operation completed before root lock release');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`expected ${count} separate PostgreSQL waiters`);
        };
        try {
          start(first);
          await blocked(1);
          start(first === 'snapshot' ? 'writer' : 'snapshot');
          await blocked(2);
        } finally {
          await holder.commitTransaction();
          await holder.release();
          await Promise.all(pending);
        }
        const [firstResult, secondResult] = await Promise.all(pending);
        const snapshot = first === 'snapshot' ? firstResult : secondResult;
        const changed = first === 'writer' ? firstResult : secondResult;
        expect(changed.status).toBe(writer === 'overwrite' ? 200 : 204);
        if (writer === 'delete' && first === 'writer') {
          expect(snapshot.status).toBe(404);
          expect(
            await app.get(DataSource).getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns }),
          ).toBe(0);
          return;
        }
        expect(snapshot.status).toBe(201);
        const expectedBytes = writer === 'overwrite' && first === 'writer' ? newBytes : oldBytes;
        expect(snapshot.body.sha256).toBe(createHash('sha256').update(expectedBytes).digest('hex'));
        expect(snapshot.body.rootNodeId).toBe(decodeRevision(snapshot.body.sourceRevision).id);
        expect(
          (await request(httpServer).get(`${base}/snapshots/${snapshot.body.snapshotId}/content`).expect(200))
            .body,
        ).toEqual(expectedBytes);
        expect(snapshot.body.sourceRevision).toBe(
          first === 'snapshot'
            ? before.revision
            : (await request(httpServer).get(`${base}/revision`).query({ path: '/race' }).expect(200)).body
                .revision,
        );
      },
    );

    describe('sourceRevision 조건', () => {
      async function seedFile(name: string, path = '/doc') {
        const ns = await createNamespace(name);
        const base = `/api/v2/namespaces/${ns}/fs`;
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path })
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from([1, 2, 3]))
          .expect(201);
        const revision = async (target = path) =>
          (await request(httpServer).get(`${base}/revision`).query({ path: target }).expect(200)).body
            .revision as string;
        const stat = async (target = path) =>
          (await request(httpServer).get(`${base}/stat`).query({ path: target }).expect(200)).body;
        const overwrite = (bytes: Buffer) =>
          request(httpServer)
            .post(`${base}/content`)
            .query({ path, force: true })
            .set('Content-Type', 'application/octet-stream')
            .send(bytes);
        return { ns, base, revision, stat, overwrite };
      }

      // snapshot·manifest·Blob ref·retained usage 행을 한 번에 비교하기 위한 요약
      async function rowCounts(ns: string) {
        const ds = app.get(DataSource);
        const blobs = await ds.getRepository(BlobEntity).findBy({ namespaceId: ns });
        const namespace = await ds.getRepository(NamespaceEntity).findOneByOrFail({ id: ns });
        return {
          snapshots: await ds.getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns }),
          entries: await ds.getRepository(VfsSnapshotEntryEntity).countBy({ namespaceId: ns }),
          blobRefs: blobs.map((blob) => `${blob.id}:${blob.referenceCount}`).sort(),
          retainedNodes: namespace.retainedSnapshotNodeCount,
          retainedBytes: String(namespace.retainedSnapshotByteCount),
        };
      }

      const fileBody = (sourceRevision?: string, path = '/doc') =>
        JSON.stringify({ kind: 'file', path, ...(sourceRevision ? { sourceRevision } : {}) });

      it('현재 revision과 일치하면 snapshot을 만들고 그 revision을 고정한다', async () => {
        const { ns, base, revision } = await seedFile('snapshot-source-match');
        const current = await revision();
        const before = await rowCounts(ns);
        const created = await snapshotPost(base, '', randomUUID(), fileBody(current)).expect(201);
        expect(created.body).toMatchObject({ kind: 'file', sourcePath: '/doc', sourceRevision: current });
        const after = await rowCounts(ns);
        expect(after.snapshots).toBe(before.snapshots + 1);
        expect(after.entries).toBe(before.entries + 1);
        expect(after.retainedNodes).toBe(before.retainedNodes + 1);
      });

      it('오래된 revision은 current를 담은 412를 반환하고 snapshot·manifest·Blob ref·usage 행을 만들지 않는다', async () => {
        const { ns, base, revision, stat, overwrite } = await seedFile('snapshot-source-stale');
        const stale = await revision();
        await overwrite(Buffer.from([9, 9])).expect(200);
        const before = await rowCounts(ns);
        const currentStat = await stat();
        const currentRevision = await revision();
        expect(currentRevision).not.toBe(stale);
        const failed = await snapshotPost(base, '', randomUUID(), fileBody(stale)).expect(412);
        expect(failed.body).toMatchObject({
          code: 'VFS_PRECONDITION_FAILED',
          path: '/doc',
          current: { ...withoutStatHash(currentStat), revision: currentRevision },
        });
        expect(await rowCounts(ns)).toEqual(before);
      });

      it.each(['snapshot', 'writer'] as const)(
        '동시 overwrite와의 순서가 sourceRevision 판정과 일치한다: PostgreSQL %s 선행',
        async (first) => {
          const { ns, base, revision, stat, overwrite } = await seedFile(`snapshot-source-race-${first}`);
          const oldRevision = await revision();
          const oldStat = await stat();
          const before = await rowCounts(ns);
          const holder = migrationDataSource.createQueryRunner();
          await holder.connect();
          await holder.startTransaction();
          const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
          await holder.query(
            'SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE',
            [ns],
          );
          const pending: Promise<request.Response>[] = [];
          let completed = 0;
          const start = (operation: 'snapshot' | 'writer') => {
            const req =
              operation === 'snapshot'
                ? snapshotPost(base, '', randomUUID(), fileBody(oldRevision))
                : overwrite(Buffer.from([7, 7, 7, 7]));
            pending.push(
              req.then((response) => {
                completed++;
                return response;
              }),
            );
          };
          const blocked = async (count: number) => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              const rows = await migrationDataSource.query(
                'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0',
                [holderPid],
              );
              if (rows.length >= count) {
                expect(new Set(rows.map((row: { pid: number }) => row.pid)).size).toBe(count);
                return;
              }
              if (completed) throw new Error('operation completed before root lock release');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`expected ${count} separate PostgreSQL waiters`);
          };
          try {
            start(first);
            await blocked(1);
            start(first === 'snapshot' ? 'writer' : 'snapshot');
            await blocked(2);
          } finally {
            await holder.commitTransaction();
            await holder.release();
            await Promise.all(pending);
          }
          const results = await Promise.all(pending);
          const snapshot = results[first === 'snapshot' ? 0 : 1];
          const writer = results[first === 'writer' ? 0 : 1];
          expect(writer.status).toBe(200);
          if (first === 'snapshot') {
            // capture가 먼저 root 잠금을 얻으면 옛 revision과 옛 bytes를 고정한다.
            expect(snapshot.status).toBe(201);
            expect(snapshot.body.sourceRevision).toBe(oldRevision);
            expect(
              (
                await request(httpServer)
                  .get(`${base}/snapshots/${snapshot.body.snapshotId}/content`)
                  .expect(200)
              ).body,
            ).toEqual(Buffer.from([1, 2, 3]));
            expect((await rowCounts(ns)).snapshots).toBe(before.snapshots + 1);
          } else {
            // writer가 먼저 커밋되면 옛 revision은 412이고 current는 writer 결과다.
            expect(snapshot.status).toBe(412);
            const after = await stat();
            const afterRevision = await revision();
            expect(after).not.toEqual(oldStat);
            expect(afterRevision).not.toBe(oldRevision);
            expect(snapshot.body).toMatchObject({
              code: 'VFS_PRECONDITION_FAILED',
              current: { ...withoutStatHash(after), revision: afterRevision },
            });
            // writer가 Blob을 교체하므로 ref는 새 Blob의 노드 참조 1개만 남아야 한다(snapshot ref 없음).
            const after412 = await rowCounts(ns);
            expect({ ...after412, blobRefs: undefined }).toEqual({ ...before, blobRefs: undefined });
            expect(after412.blobRefs.map((ref) => Number(ref.split(':')[1])).sort()).toEqual([0, 1]);
          }
        },
      );

      it('같은 key와 같은 요청 재시도는 원본이 바뀐 뒤에도 최초 snapshot ID를 재생한다', async () => {
        const { ns, base, revision, overwrite } = await seedFile('snapshot-source-lost-response');
        const key = randomUUID();
        const raw = fileBody(await revision());
        const first = await snapshotPost(base, '', key, raw).expect(201);
        // 응답이 유실된 클라이언트가 원본 변경 뒤 같은 요청을 다시 보내는 상황이다.
        await overwrite(Buffer.from([5])).expect(200);
        const replay = await snapshotPost(base, '', key, raw).expect(201);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
        expect((await rowCounts(ns)).snapshots).toBe(1);
      });

      it('같은 key에서 sourceRevision만 바뀌거나 추가·제거되면 MUTATION_KEY_REUSED이다', async () => {
        const { base, revision, overwrite } = await seedFile('snapshot-source-key-reuse');
        const first = await revision();
        await overwrite(Buffer.from([4, 4])).expect(200);
        const second = await revision();
        const key = randomUUID();
        await snapshotPost(base, '', key, fileBody(second)).expect(201);
        for (const changed of [fileBody(first), fileBody()]) {
          expect((await snapshotPost(base, '', key, changed).expect(409)).body.code).toBe(
            'MUTATION_KEY_REUSED',
          );
        }
        const noCondition = randomUUID();
        await snapshotPost(base, '', noCondition, fileBody()).expect(201);
        expect((await snapshotPost(base, '', noCondition, fileBody(second)).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
      });

      it('최초 412를 원본이 다시 바뀐 뒤와 앱 재시작 뒤에도 최초 body와 X-Request-Id로 재생한다', async () => {
        const { ns, base, revision, stat, overwrite } = await seedFile('snapshot-source-412-replay');
        const stale = await revision();
        await overwrite(Buffer.from([8, 8])).expect(200);
        const statAtConflict = await stat();
        const revisionAtConflict = await revision();
        const key = randomUUID();
        const raw = fileBody(stale);
        const first = await snapshotPost(base, '', key, raw).expect(412);
        expect(first.body.current).toEqual(withoutStatHash(statAtConflict));
        await overwrite(Buffer.from([6, 6, 6])).expect(200);
        // 원본이 다시 바뀌어 현재 revision은 충돌 시점과 다르다.
        expect(await revision()).not.toBe(revisionAtConflict);
        const replay = await snapshotPost(base, '', key, raw).expect(412);
        expect(replay.body).toEqual(first.body);
        expect(replay.body.current.revision).toBe(revisionAtConflict);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);

        const oldDataSource = app.get(DataSource);
        await app.close();
        expect(oldDataSource.isInitialized).toBe(false);
        await bootstrap();
        const afterRestart = await snapshotPost(base, '', key, raw).expect(412);
        expect(afterRestart.body).toEqual(first.body);
        expect(afterRestart.body.current.revision).toBe(revisionAtConflict);
        expect(afterRestart.headers['x-request-id']).toBe(first.headers['x-request-id']);
        expect((await rowCounts(ns)).snapshots).toBe(0);
        // 같은 revision으로 새 key를 쓰면 여전히 최신 상태를 평가한다.
        const latestRevision = await revision();
        const fresh = await snapshotPost(base, '', randomUUID(), raw).expect(412);
        expect(fresh.body.current.revision).toBe(latestRevision);
        expect(fresh.body.current.revision).not.toBe(revisionAtConflict);
        expect(fresh.body.current).toEqual(withoutStatHash(await stat()));
      });

      it('성공한 snapshot 응답도 앱 재시작 뒤 같은 ID로 재생한다', async () => {
        const { ns, base, revision } = await seedFile('snapshot-source-success-restart');
        const key = randomUUID();
        const raw = fileBody(await revision());
        const first = await snapshotPost(base, '', key, raw).expect(201);
        const oldDataSource = app.get(DataSource);
        await app.close();
        expect(oldDataSource.isInitialized).toBe(false);
        await bootstrap();
        const replay = await snapshotPost(base, '', key, raw).expect(201);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
        expect((await rowCounts(ns)).snapshots).toBe(1);
      });

      it('원본 부재 404와 디렉터리 409가 revision 불일치 412보다 먼저이고 잘못된 요청은 400이다', async () => {
        const { ns, base, revision } = await seedFile('snapshot-source-precedence');
        await request(httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
        const stale = encodeRevision({ id: randomUUID(), version: 1 });
        const before = await rowCounts(ns);
        const missing = await snapshotPost(base, '', randomUUID(), fileBody(stale, '/missing')).expect(404);
        expect(missing.body.code).toBe('VFS_NODE_NOT_FOUND');
        for (const sourceRevision of [stale, await revision('/dir')]) {
          const directory = await snapshotPost(
            base,
            '',
            randomUUID(),
            fileBody(sourceRevision, '/dir'),
          ).expect(409);
          expect(directory.body.code).toBe('VFS_IS_DIRECTORY');
        }
        const malformed = await snapshotPost(base, '', randomUUID(), fileBody('r1.bad')).expect(400);
        expect(malformed.body.code).toBe('VFS_INVALID_REVISION');
        const tree = await snapshotPost(
          base,
          '',
          randomUUID(),
          JSON.stringify({ kind: 'tree', path: '/dir', sourceRevision: await revision('/dir') }),
        ).expect(400);
        expect(tree.body.code).toBe('VFS_INVALID_MUTATION_REQUEST');
        expect(await rowCounts(ns)).toEqual(before);
        // 404·409도 receipt로 재생된다.
        const key = randomUUID();
        const first = await snapshotPost(base, '', key, fileBody(stale, '/dir')).expect(409);
        const replay = await snapshotPost(base, '', key, fileBody(stale, '/dir')).expect(409);
        expect(replay.body).toEqual(first.body);
      });
    });

    it('restore 생성/교체는 같은 Blob과 MIME을 유지하며 revision과 receipt를 원자적으로 갱신한다', async () => {
      const { ns, base, bytes, blob, id } = await restoreFixture('snapshot-restore-lifecycle');
      await request(httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
      const key = randomUUID();
      const raw = '{"path":"/target","ifAbsent":true}';
      const restored = await snapshotPost(base, `/${id}/restore`, key, raw).expect(201);
      expect(restored.body).toMatchObject({
        snapshotId: id,
        resource: { path: '/target', version: 1, mimeType: 'application/octet-stream' },
      });
      const target = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId: ns, name: 'target' });
      expect(target.blobId).toBe(blob.id);
      expect(restored.body.affectedRevisions).toContainEqual({
        path: '/target',
        revision: encodeRevision(target),
      });
      const replay = await snapshotPost(base, `/${id.toUpperCase()}/restore`, key, raw).expect(201);
      expect(replay.body).toEqual(restored.body);
      expect(replay.headers['x-request-id']).toBe(restored.headers['x-request-id']);
      expect((await snapshotPost(base, `/${id}/restore`, key, raw + ' ').expect(409)).body.code).toBe(
        'MUTATION_KEY_REUSED',
      );
      const beforeRoot = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
      const replaced = await snapshotPost(
        base,
        `/${id}/restore`,
        randomUUID(),
        JSON.stringify({ path: '/target', ifRevision: encodeRevision(target) }),
      ).expect(200);
      const afterTarget = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ id: target.id });
      const afterRoot = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ id: beforeRoot.id });
      expect(afterTarget.version).toBe(target.version + 1);
      expect(afterRoot.version).toBe(beforeRoot.version + 1);
      expect(replaced.body.resource.version).toBe(afterTarget.version);
      expect(replaced.body.affectedRevisions).toContainEqual({
        path: '/target',
        revision: encodeRevision(afterTarget),
      });
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount,
      ).toBe(2);
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/target', force: 'true' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('new'))
        .expect(200);
      const changed = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ id: target.id });
      await snapshotPost(
        base,
        `/${id}/restore`,
        randomUUID(),
        JSON.stringify({ path: '/target', ifRevision: encodeRevision(changed) }),
      ).expect(200);
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: changed.blobId! }))
          .referenceCount,
      ).toBe(0);
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount,
      ).toBe(2);
      await snapshotPost(base, `/${id}/delete`, randomUUID(), '{}').expect(200);
      const content = await request(httpServer).get(`${base}/content`).query({ path: '/target' }).expect(200);
      expect(content.body).toEqual(bytes);
      expect(content.headers['content-type']).toBe('application/octet-stream');
    });

    it('restore 조건 오류와 directory/parent/다른 namespace/없는 snapshot을 구별한다', async () => {
      const { ns, base, id } = await restoreFixture('snapshot-restore-errors');
      const node = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId: ns, name: 'source' });
      const revision = encodeRevision(node);
      const cases: [object, number][] = [
        [{ path: '/target' }, 428],
        [{ path: '/target', ifAbsent: true, ifRevision: revision }, 400],
        [{ path: '/target', ifAbsent: false }, 400],
        [{ path: '/target', ifRevision: 'bad' }, 400],
        [{ path: '/target', ifRevision: revision }, 404],
        [{ path: '/missing/target', ifAbsent: true }, 404],
        [{ path: '/source', ifAbsent: true }, 412],
        [{ path: '/source', ifRevision: encodeRevision({ id: randomUUID(), version: 1 }) }, 412],
      ];
      for (const [body, status] of cases)
        await snapshotPost(base, `/${id}/restore`, randomUUID(), JSON.stringify(body)).expect(status);
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      for (const condition of [{ ifAbsent: true }, { ifRevision: revision }])
        await snapshotPost(
          base,
          `/${id}/restore`,
          randomUUID(),
          JSON.stringify({ path: '/dir', ...condition }),
        ).expect(409);
      await snapshotPost(
        base,
        `/${randomUUID()}/restore`,
        randomUUID(),
        '{"path":"/source","ifAbsent":true}',
      ).expect(404);
      const other = await createNamespace('snapshot-restore-other');
      await snapshotPost(
        `/api/v2/namespaces/${other}/fs`,
        `/${id}/restore`,
        randomUUID(),
        '{"path":"/target","ifAbsent":true}',
      ).expect(404);
      const ds = app.get(DataSource);
      await ds.getRepository(VfsSnapshotEntity).update(id, { kind: 'TREE', rootType: 'DIRECTORY' });
      await snapshotPost(base, `/${id}/restore`, randomUUID(), '{"path":"/source","ifAbsent":true}').expect(
        409,
      );
      expect(
        (await migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: node.id })).version,
      ).toBe(node.version);
    });

    it('restore receipt 실패는 target/refcount/revision을 롤백하고 같은 key 재시도를 허용한다', async () => {
      const { ns, base, id, blob } = await restoreFixture('snapshot-restore-rollback');
      const key = randomUUID();
      const raw = '{"path":"/target","ifAbsent":true}';
      const root = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
      const spy = jest
        .spyOn(app.get(VfsMutationReceiptRepository), 'complete')
        .mockRejectedValueOnce(new Error('injected restore receipt failure'));
      try {
        await snapshotPost(base, `/${id}/restore`, key, raw).expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(
        await migrationDataSource.getRepository(VfsNodeEntity).findOneBy({ namespaceId: ns, name: 'target' }),
      ).toBeNull();
      expect(
        (await migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version,
      ).toBe(root.version);
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount,
      ).toBe(2);
      expect(
        await migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .findOneBy({ namespaceId: ns, idempotencyKey: key }),
      ).toBeNull();
      await snapshotPost(base, `/${id}/restore`, key, raw).expect(201);
    });

    it('restore가 namespace 논리 quota를 넘으면 파일·snapshot·Blob 참조·revision·사용량을 유지한다', async () => {
      const { ns, base, id, blob } = await restoreFixture('snapshot-restore-quota');
      await request(httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
      await migrationDataSource.getRepository(NamespaceEntity).update(ns, { maxTotalLogicalBytes: '7' });
      const root = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
      const namespaceBefore = await migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: ns });
      const snapshotDataSource = app.get(DataSource);
      const snapshotBefore = await snapshotDataSource.getRepository(VfsSnapshotEntity).findOneByOrFail({ id });
      const entryCountBefore = await snapshotDataSource.getRepository(VfsSnapshotEntryEntity).countBy({ snapshotId: id });
      const blobBefore = await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id });

      const rejected = await snapshotPost(
        base,
        `/${id}/restore`,
        randomUUID(),
        '{"path":"/target","ifAbsent":true}',
      ).expect(413);
      expect(rejected.body.code).toBe('VFS_QUOTA_EXCEEDED');
      expect(await migrationDataSource.getRepository(VfsNodeEntity).findOneBy({ namespaceId: ns, name: 'target' })).toBeNull();
      expect((await migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version).toBe(root.version);
      const namespaceAfter = await migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: ns });
      expect(String(namespaceAfter.liveFileByteCount)).toBe(String(namespaceBefore.liveFileByteCount));
      expect(String(namespaceAfter.retainedSnapshotByteCount)).toBe(String(namespaceBefore.retainedSnapshotByteCount));
      expect(namespaceAfter.retainedSnapshotNodeCount).toBe(namespaceBefore.retainedSnapshotNodeCount);
      expect(await snapshotDataSource.getRepository(VfsSnapshotEntity).findOneByOrFail({ id })).toEqual(snapshotBefore);
      expect(await snapshotDataSource.getRepository(VfsSnapshotEntryEntity).countBy({ snapshotId: id })).toBe(entryCountBefore);
      expect((await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount).toBe(blobBefore.referenceCount);
    });

    it('restore 교체 rollback은 두 Blob 참조와 기존 bytes/revision 및 snapshot 예산을 보존한다', async () => {
      const { ns, base, id, blob } = await restoreFixture('snapshot-restore-replace-rollback');
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/target' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('old target'))
        .expect(201);
      const target = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId: ns, name: 'target' });
      const key = randomUUID();
      const raw = JSON.stringify({ path: '/target', ifRevision: encodeRevision(target) });
      const spy = jest
        .spyOn(app.get(VfsMutationReceiptRepository), 'complete')
        .mockRejectedValueOnce(new Error('injected restore replace failure'));
      try {
        await snapshotPost(base, `/${id}/restore`, key, raw).expect(500);
      } finally {
        spy.mockRestore();
      }
      const after = await migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: target.id });
      expect(after.blobId).toBe(target.blobId);
      expect(after.version).toBe(target.version);
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount,
      ).toBe(2);
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: target.blobId! }))
          .referenceCount,
      ).toBe(1);
      const namespace = await migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: ns });
      expect(namespace.retainedSnapshotNodeCount).toBe(1);
      expect(String(namespace.retainedSnapshotByteCount)).toBe(blob.size);
      expect(
        (await request(httpServer).get(`${base}/content`).query({ path: '/target' }).expect(200)).body,
      ).toEqual(Buffer.from('old target'));
      await snapshotPost(base, `/${id}/restore`, key, raw).expect(200);
    });

    it('restore 412를 current와 함께 receipt로 고정해 target 제거 뒤에도 같은 key는 재생한다', async () => {
      const { base, id } = await restoreFixture('snapshot-restore-condition-retry');
      const key = randomUUID();
      const raw = '{"path":"/source","ifAbsent":true}';
      const stat = (await request(httpServer).get(`${base}/stat`).query({ path: '/source' }).expect(200))
        .body;
      const revisionAtConflict = (
        await request(httpServer).get(`${base}/revision`).query({ path: '/source' }).expect(200)
      ).body.revision as string;
      const first = await snapshotPost(base, `/${id}/restore`, key, raw).expect(412);
      expect(first.body).toMatchObject({
        code: 'VFS_PRECONDITION_FAILED',
        path: '/source',
        current: { ...withoutStatHash(stat), revision: revisionAtConflict },
      });
      await request(httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
      const replay = await snapshotPost(base, `/${id}/restore`, key, raw).expect(412);
      expect(replay.body).toEqual(first.body);
      expect(replay.body.current.revision).toBe(revisionAtConflict);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      expect(
        (await snapshotPost(base, `/${id}/restore`, key, '{"path":"/source","ifAbsent":true }').expect(409))
          .body.code,
      ).toBe('MUTATION_KEY_REUSED');
      await snapshotPost(base, `/${id}/restore`, randomUUID(), raw).expect(201);
    });

    it.each(['restore', 'delete'] as const)(
      'PostgreSQL root lock 순서 %s 선행은 restore/delete를 직렬화한다',
      async (first) => {
        const { ns, base, bytes, id, blob } = await restoreFixture(`snapshot-restore-race-${first}`);
        const holder = migrationDataSource.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        const [{ pid: holderPid }] = await holder.query('SELECT pg_backend_pid() AS pid');
        await holder.query(
          'SELECT id FROM vfs_node WHERE namespace_id = $1 AND parent_id IS NULL FOR UPDATE',
          [ns],
        );
        const pending: Promise<request.Response>[] = [];
        let completed = 0;
        const start = (operation: 'restore' | 'delete') => {
          const result = snapshotPost(
            base,
            `/${id}/${operation}`,
            randomUUID(),
            operation === 'restore' ? '{"path":"/target","ifAbsent":true}' : '{}',
          ).then((response) => {
            completed += 1;
            return response;
          });
          pending.push(result);
        };
        const blocked = async (count: number) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const rows = await migrationDataSource.query(
              'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0',
              [holderPid],
            );
            if (rows.length >= count) {
              expect(new Set(rows.map((row: { pid: number }) => row.pid)).size).toBe(count);
              return;
            }
            if (completed > 0) throw new Error('mutation finished before root lock release');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`expected ${count} PostgreSQL root lock waiters`);
        };
        try {
          start(first);
          await blocked(1);
          start(first === 'restore' ? 'delete' : 'restore');
          await blocked(2);
        } finally {
          await holder.commitTransaction();
          await holder.release();
          await Promise.all(pending);
        }
        const [one, two] = await Promise.all(pending);
        expect([one.status, two.status]).toEqual(first === 'restore' ? [201, 200] : [200, 404]);
        expect(await app.get(DataSource).getRepository(VfsSnapshotEntity).findOneBy({ id })).toBeNull();
        const target = await migrationDataSource
          .getRepository(VfsNodeEntity)
          .findOneBy({ namespaceId: ns, name: 'target' });
        expect(target?.blobId ?? null).toBe(first === 'restore' ? blob.id : null);
        expect(
          (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id }))
            .referenceCount,
        ).toBe(first === 'restore' ? 2 : 1);
        for (const path of first === 'restore' ? ['/source', '/target'] : ['/source'])
          expect((await request(httpServer).get(`${base}/content`).query({ path }).expect(200)).body).toEqual(
            bytes,
          );
      },
    );

    it('원본 overwrite/delete 뒤에도 binary bytes와 정규화 MIME을 유지하고 삭제는 한 번만 ref를 해제한다', async () => {
      const ns = await createNamespace('snapshot-file-lifecycle');
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/binary' })
        .set('Content-Type', 'Application/Octet-Stream; ignored=value')
        .send(bytes)
        .expect(201);
      const blob = await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns });
      const key = randomUUID();
      const raw = '{"kind":"file","path":"/binary"}';
      const first = await snapshotPost(base, '', key, raw).expect(201);
      expect(first.body).toMatchObject({
        snapshotId: expect.any(String),
        kind: 'file',
        sourcePath: '/binary',
        nodeCount: 1,
        logicalBytes: '6',
      });
      const id = first.body.snapshotId as string;
      expect((await snapshotPost(base, '', key, raw).expect(201)).body).toEqual(first.body);
      expect((await snapshotPost(base, '', key, raw).expect(201)).headers['x-request-id']).toBe(
        first.headers['x-request-id'],
      );
      for (const changed of ['{ "kind":"file","path":"/binary"}', '{"kind":"file","path":"/other"}']) {
        expect((await snapshotPost(base, '', key, changed).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
      }
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount,
      ).toBe(2);
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/binary', force: 'true' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('replacement'))
        .expect(200);
      await request(httpServer).post(`${base}/rm`).query({ path: '/binary' }).expect(204);
      expect((await request(httpServer).get(`${base}/snapshots/${id}`).expect(200)).body).toEqual(first.body);
      const read = await request(httpServer).get(`${base}/snapshots/${id}/content`).expect(200);
      expect(read.body).toEqual(bytes);
      expect(read.headers['content-type']).toBe('application/octet-stream');
      const range = await request(httpServer)
        .get(`${base}/snapshots/${id}/content`)
        .set('Range', 'bytes=1-3')
        .expect(206);
      expect(range.body).toEqual(bytes.subarray(1, 4));
      expect(range.headers['content-range']).toBe('bytes 1-3/6');
      await request(httpServer)
        .get(`${base}/snapshots/${id}/content`)
        .set('Range', 'bytes=99-100')
        .expect(416);
      const other = await createNamespace('snapshot-file-other');
      const otherBase = `/api/v2/namespaces/${other}/fs`;
      await request(httpServer).get(`${otherBase}/snapshots/${id}`).expect(404);
      await request(httpServer).get(`${otherBase}/snapshots/${id}/content`).expect(404);
      await snapshotPost(otherBase, `/${id}/delete`, randomUUID(), '{}').expect(404);
      const deleteKey = randomUUID();
      const removed = await snapshotPost(base, `/${id}/delete`, deleteKey, '{}').expect(200);
      expect(removed.body).toEqual({ snapshotId: id, deleted: true });
      expect((await snapshotPost(base, `/${id}/delete`, deleteKey, '{}').expect(200)).body).toEqual(
        removed.body,
      );
      expect(
        (await snapshotPost(base, `/${id}/delete`, deleteKey, '{}').expect(200)).headers['x-request-id'],
      ).toBe(removed.headers['x-request-id']);
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id })).referenceCount,
      ).toBe(0);
      const namespace = await migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: ns });
      expect(namespace.retainedSnapshotNodeCount).toBe(0);
      expect(String(namespace.retainedSnapshotByteCount)).toBe('0');
      await request(httpServer).get(`${base}/snapshots/${id}`).expect(404);
      await request(httpServer).get(`${base}/snapshots/${id}/content`).expect(404);
      await snapshotPost(base, `/${id}/delete`, randomUUID(), '{}').expect(404);
      expect(
        (await snapshotPost(base, `/${randomUUID()}/delete`, deleteKey, '{}').expect(409)).body.code,
      ).toBe('MUTATION_KEY_REUSED');
    });

    it('삭제된 snapshot과 없는 snapshot의 delete 404를 같은 key에서 최초 body와 X-Request-Id로 재생한다', async () => {
      const { ns, base, id } = await restoreFixture('snapshot-delete-404-replay');
      await snapshotPost(base, `/${id}/delete`, randomUUID(), '{}').expect(200);
      for (const target of [id, randomUUID()]) {
        const key = randomUUID();
        const first = await snapshotPost(base, `/${target}/delete`, key, '{}').expect(404);
        expect(first.body.code).toBe('VFS_SNAPSHOT_NOT_FOUND');
        expect(
          await migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .findOneBy({ namespaceId: ns, scope, idempotencyKey: key }),
        ).toMatchObject({ state: 'COMPLETE', responseStatus: 404 });
        const replay = await snapshotPost(base, `/${target}/delete`, key, '{}').expect(404);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      }
    });

    it('암호화 FILE의 원본 삭제 뒤 전체/Range 읽기도 원본 bytes를 반환한다', async () => {
      const nsResponse = await request(httpServer)
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', 'snapshot-encrypted-ns')
        .send({ name: 'snapshot-encrypted', encryptionPolicy: 'ENCRYPTED' })
        .expect(201);
      const ns = nsResponse.body.id as string;
      const base = `/api/v2/namespaces/${ns}/fs`;
      const bytes = Buffer.from(Array.from({ length: 80 }, (_, i) => i * 3));
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/secret' })
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)
        .expect(201);
      const captured = await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/secret"}').expect(
        201,
      );
      await request(httpServer).post(`${base}/rm`).query({ path: '/secret' }).expect(204);
      const content = `${base}/snapshots/${captured.body.snapshotId}/content`;
      expect((await request(httpServer).get(content).expect(200)).body).toEqual(bytes);
      expect((await request(httpServer).get(content).set('Range', 'bytes=13-47').expect(206)).body).toEqual(
        bytes.subarray(13, 48),
      );
    });

    it('receipt 실패 시 metadata/ref/usage를 롤백하고 같은 key로 재시도한다', async () => {
      const ns = await createNamespace('snapshot-atomic-receipt');
      const base = `/api/v2/namespaces/${ns}/fs`;
      await request(httpServer).post(`${base}/touch`).send({ path: '/a' }).expect(201);
      const ds = app.get(DataSource);
      const key = randomUUID();
      const raw = '{"kind":"file","path":"/a"}';
      const failure = jest
        .spyOn(app.get(VfsMutationReceiptRepository), 'complete')
        .mockRejectedValueOnce(new Error('injected snapshot receipt failure'));
      try {
        await snapshotPost(base, '', key, raw).expect(500);
      } finally {
        failure.mockRestore();
      }
      expect(await ds.getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(0);
      expect(await ds.getRepository(VfsSnapshotEntryEntity).countBy({ namespaceId: ns })).toBe(0);
      expect((await ds.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns })).referenceCount).toBe(
        1,
      );
      expect(
        (await ds.getRepository(NamespaceEntity).findOneByOrFail({ id: ns })).retainedSnapshotNodeCount,
      ).toBe(0);
      expect(await ds.getRepository(VfsMutationReceiptEntity).countBy({ namespaceId: ns })).toBe(0);
      const snapshot = await snapshotPost(base, '', key, raw).expect(201);
      const deletionKey = randomUUID();
      const deleteFailure = jest
        .spyOn(app.get(VfsMutationReceiptRepository), 'complete')
        .mockRejectedValueOnce(new Error('injected snapshot delete failure'));
      try {
        await snapshotPost(base, `/${snapshot.body.snapshotId}/delete`, deletionKey, '{}').expect(500);
      } finally {
        deleteFailure.mockRestore();
      }
      expect(await ds.getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(1);
      expect((await ds.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns })).referenceCount).toBe(
        2,
      );
      await snapshotPost(base, `/${snapshot.body.snapshotId}/delete`, deletionKey, '{}').expect(200);
    });

    it('work 412의 오류 receipt fencing이 실패하면 500이고 receipt를 남기지 않아 같은 key 재시도가 재평가된다', async () => {
      const { ns, base, id } = await restoreFixture('snapshot-error-receipt-fence');
      const key = randomUUID();
      const raw = '{"path":"/source","ifAbsent":true}';
      // restore work가 412를 던지고 롤백된 뒤 별도 트랜잭션의 오류 receipt 저장이 claim lost로 실패한다.
      const fenced = jest
        .spyOn(app.get(VfsMutationReceiptRepository), 'completeAfterRollback')
        .mockRejectedValueOnce(new Error('VFS mutation claim lost'));
      try {
        await snapshotPost(base, `/${id}/restore`, key, raw).expect(500);
        expect(fenced).toHaveBeenCalledTimes(1);
      } finally {
        fenced.mockRestore();
      }
      expect(
        await migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .findOneBy({ namespaceId: ns, scope, idempotencyKey: key }),
      ).toBeNull();
      // 412가 저장되지 않았으므로 원본을 지운 뒤 같은 key 재시도는 새로 평가되어 복원된다.
      await request(httpServer).post(`${base}/rm`).query({ path: '/source' }).expect(204);
      const retried = await snapshotPost(base, `/${id}/restore`, key, raw).expect(201);
      expect(retried.body.resource.path).toBe('/source');
    });

    it('한도 초과 413을 완료 receipt로 재생하며 원본 종류와 ID를 검증한다', async () => {
      const ns = await createNamespace('snapshot-file-errors');
      const base = `/api/v2/namespaces/${ns}/fs`;
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/a' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('ab'))
        .expect(201);
      await migrationDataSource.getRepository(NamespaceEntity).update(ns, { maxSnapshotBytes: '1' });
      const root = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId: ns, parentId: IsNull() });
      const key = randomUUID();
      const raw = '{"kind":"file","path":"/a"}';
      const limited = await snapshotPost(base, '', key, raw).expect(413);
      expect(limited.body.code).toBe('VFS_SNAPSHOT_LIMIT_EXCEEDED');
      expect(await app.get(DataSource).getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(0);
      expect(
        (await migrationDataSource.getRepository(BlobEntity).findOneByOrFail({ namespaceId: ns }))
          .referenceCount,
      ).toBe(1);
      expect((await migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version).toBe(root.version);
      expect(
        String((await migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: ns })).retainedSnapshotByteCount),
      ).toBe('0');
      await migrationDataSource.getRepository(NamespaceEntity).update(ns, { maxSnapshotBytes: null });
      const replayed = await snapshotPost(base, '', key, raw).expect(413);
      expect(replayed.body).toEqual(limited.body);
      expect(replayed.headers['x-request-id']).toBe(limited.headers['x-request-id']);
      expect(await app.get(DataSource).getRepository(VfsSnapshotEntity).countBy({ namespaceId: ns })).toBe(0);
      const snapshot = await snapshotPost(base, '', randomUUID(), raw).expect(201);
      await request(httpServer)
        .get(`${base}/snapshots/${snapshot.body.snapshotId}/content`)
        .query({ path: ['a', 'b'] })
        .expect(400);
      await request(httpServer).get(`${base}/snapshots/not-a-uuid`).expect(404);
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      expect(
        (await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/dir"}').expect(409)).body.code,
      ).toBe('VFS_IS_DIRECTORY');
      await snapshotPost(base, '', randomUUID(), '{"kind":"file","path":"/missing"}').expect(404);
    });

    it('빈 본문과 잘못된 JSON의 400을 원래 request ID로 재생한다', async () => {
      const ns = await createNamespace('snapshot-invalid-json');
      const base = `/api/v2/namespaces/${ns}/fs`;
      for (const raw of ['', '{broken']) {
        const key = randomUUID();
        const first = await snapshotPost(base, '', key, raw).expect(400);
        expect(first.body.code).toBe('VFS_INVALID_MUTATION_REQUEST');
        const replay = await snapshotPost(base, '', key, raw).expect(400);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      }
    });

    it('진행 중 key는 Retry-After를 제공하고 key와 scope를 검증한다', async () => {
      const namespaceId = await createNamespace('snapshot-busy');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const key = randomUUID();
      await app.get(VfsMutationReceiptRepository).claim({ namespaceId, scope, key }, new Date());
      const busy = await snapshotPost(base, '', key, '{"kind":"file","path":"/a"}').expect(409);
      expect(busy.body.code).toBe('MUTATION_IN_PROGRESS');
      expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
      await snapshotPost(base, '', 'invalid', '{}').expect(400);
      await request(httpServer)
        .post(`${base}/snapshots`)
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'file', path: '/a' })
        .expect(400);
    });
  });

  describe('conditional mutation receipts', () => {
    it.each(['move', 'copy'] as const)(
      '%s exact 목적지 충돌·receipt 재생·기존 배치 유지를 HTTP 경계에서 지킨다',
      async (kind) => {
        const namespaceId = await createNamespace(`exact-http-${kind}-${randomUUID()}`);
        const base = `/api/v2/namespaces/${namespaceId}/fs`;
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path: '/source' })
          .set('Content-Type', 'text/plain')
          .send('source')
          .expect(201);
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path: '/file' })
          .set('Content-Type', 'text/plain')
          .send('occupied')
          .expect(201);
        await request(httpServer).post(`${base}/mkdir`).send({ path: '/directory' }).expect(201);
        const revision = async (path: string) =>
          (await request(httpServer).get(`${base}/revision`).query({ path }).expect(200)).body
            .revision as string;
        const sourceRevision = await revision('/source');
        const mutate = (body: Record<string, unknown>, key = randomUUID()) =>
          request(httpServer)
            .post(`${base}/mutations`)
            .set('Idempotency-Key', key)
            .set('X-Mutation-Scope', 'exact-target')
            .send(body);
        const command = {
          kind,
          source: '/source',
          destination: '/file',
          sourceRevision,
          destinationAbsent: true,
          destinationResolution: 'exact',
        };
        for (const path of ['/', '/file', '/directory']) {
          const stat = (await request(httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;
          const currentRevision = await revision(path);
          const failed = await mutate({ ...command, destination: path }).expect(412);
          expect(failed.body).toMatchObject({
            code: 'VFS_PRECONDITION_FAILED',
            path,
            current: { id: stat.id, path, revision: currentRevision },
          });
        }
        const key = randomUUID();
        const failed = await mutate(command, key).expect(412);
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path: '/file', force: true })
          .set('Content-Type', 'text/plain')
          .send('changed')
          .expect(200);
        const replay = await mutate(command, key).expect(412);
        expect(replay.body).toEqual(failed.body);
        expect(replay.headers['x-request-id']).toBe(failed.headers['x-request-id']);
        expect(
          (await mutate({ ...command, destinationResolution: undefined }, key).expect(409)).body.code,
        ).toBe('MUTATION_KEY_REUSED');
        for (const value of ['placement', false, null]) {
          expect((await mutate({ ...command, destinationResolution: value }).expect(400)).body.code).toBe(
            'VFS_INVALID_MUTATION_REQUEST',
          );
        }
        const stale = await mutate({
          ...command,
          sourceRevision: encodeRevision({ id: randomUUID(), version: 1 }),
        }).expect(412);
        expect(stale.body.path).toBe('/source');
        expect(stale.body.current.revision).toBe(sourceRevision);
        const exact = await mutate({ ...command, destination: '/directory/leaf' }).expect(
          kind === 'move' ? 200 : 201,
        );
        expect(exact.body.resource.path).toBe('/directory/leaf');
        if (kind === 'move') {
          await request(httpServer)
            .post(`${base}/content`)
            .query({ path: '/legacy-source' })
            .set('Content-Type', 'text/plain')
            .send('legacy')
            .expect(201);
        }
        const legacySource = kind === 'move' ? '/legacy-source' : '/source';
        const legacy = await mutate({
          ...command,
          source: legacySource,
          sourceRevision: await revision(legacySource),
          destination: '/directory',
          destinationResolution: undefined,
        }).expect(kind === 'move' ? 200 : 201);
        expect(legacy.body.resource.path).toBe(`/directory/${legacySource.slice(1)}`);
      },
    );

    it('같은 부재 exact 목적지로 동시 copy하면 하나만 생성하고 나머지는 412다', async () => {
      const namespaceId = await createNamespace(`exact-race-${randomUUID()}`);
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of ['/one', '/two']) {
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path })
          .set('Content-Type', 'text/plain')
          .send(path)
          .expect(201);
      }
      const copy = async (source: string) =>
        request(httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', randomUUID())
          .set('X-Mutation-Scope', 'exact-race')
          .send({
            kind: 'copy',
            source,
            destination: '/target',
            sourceRevision: (
              await request(httpServer).get(`${base}/revision`).query({ path: source }).expect(200)
            ).body.revision,
            destinationAbsent: true,
            destinationResolution: 'exact',
          });
      const responses = await Promise.all([copy('/one'), copy('/two')]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
      expect(
        (await request(httpServer).get(`${base}/stat`).query({ path: '/target' }).expect(200)).body.path,
      ).toBe('/target');
      const listing = await request(httpServer).get(`${base}/ls`).query({ path: '/' }).expect(200);
      expect(listing.body.items.filter((item: { name: string }) => item.name === 'target')).toHaveLength(1);
    });

    it('NFD path 거부를 receipt로 재생하고 같은 key의 NFC 요청은 key 재사용으로 거부한다', async () => {
      const namespaceId = await createNamespace('conditional-nfd-retry-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const key = randomUUID();
      const send = (path: string, idempotencyKey = key) =>
        request(httpServer)
          .post(base)
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'caller-a')
          .send({ kind: 'mkdir', path, ifAbsent: true });
      const rejected = await send('/e\u0301').expect(400);
      expect(rejected.body.code).toBe('VFS_INVALID_PATH');
      expect(
        await migrationDataSource.getRepository(VfsMutationReceiptEntity).findBy({ namespaceId }),
      ).toMatchObject([{ state: 'COMPLETE', responseStatus: 400 }]);
      const replay = await send('/e\u0301').expect(400);
      expect(replay.body).toEqual(rejected.body);
      expect(replay.headers['x-request-id']).toBe(rejected.headers['x-request-id']);
      expect((await send('/é').expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
      const accepted = await send('/é', randomUUID()).expect(201);
      expect(accepted.body.resource.path).toBe('/é');
    });

    it('rejects decomposed delete, move, and copy paths while accepting their NFC forms', async () => {
      const namespaceId = await createNamespace('conditional-path-operations-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const mutate = (body: Record<string, unknown>) =>
        request(httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', randomUUID())
          .set('X-Mutation-Scope', 'path-contract')
          .send(body);
      const revision = async (path: string): Promise<string> =>
        (await request(httpServer).get(`${base}/revision`).query({ path }).expect(200)).body
          .revision as string;

      await request(httpServer).post(`${base}/mkdir`).send({ path: '/é' }).expect(201);
      const deleteRevision = await revision('/é');
      expect(
        (await mutate({ kind: 'delete', path: '/e\u0301', ifRevision: deleteRevision }).expect(400)).body
          .code,
      ).toBe('VFS_INVALID_PATH');
      await mutate({ kind: 'delete', path: '/é', ifRevision: deleteRevision }).expect(200);

      for (const kind of ['move', 'copy'] as const) {
        const source = `/é-${kind}`;
        const destination = `/é-${kind}-result`;
        await request(httpServer).post(`${base}/mkdir`).send({ path: source }).expect(201);
        const sourceRevision = await revision(source);
        const command = { kind, source, destination, sourceRevision, destinationAbsent: true };
        for (const invalid of [
          { ...command, source: `/e\u0301-${kind}` },
          { ...command, destination: `/e\u0301-${kind}-result` },
        ]) {
          expect((await mutate(invalid).expect(400)).body.code).toBe('VFS_INVALID_PATH');
        }
        expect((await mutate(command).expect(kind === 'move' ? 200 : 201)).body.resource.path).toBe(
          destination,
        );
      }
    });

    it('keeps tree, revisions, bytes, and Blob references after failed conditions', async () => {
      const namespaceId = await createNamespace('conditional-failure-state-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/parent' }).expect(201);
      await request(httpServer)
        .post(`${base}/content/conditional`)
        .query({ path: '/parent/file' })
        .set('Content-Type', 'text/plain')
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'state-contract')
        .set('X-If-Absent', 'true')
        .send('original')
        .expect(201);
      const read = async () => ({
        root: (await request(httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200)).body,
        parent: (await request(httpServer).get(`${base}/revision`).query({ path: '/parent' }).expect(200))
          .body,
        file: (await request(httpServer).get(`${base}/revision`).query({ path: '/parent/file' }).expect(200))
          .body,
        tree: (
          await request(httpServer)
            .get(`${base}/ls`)
            .query({ path: '/parent', consistency: 'revision' })
            .expect(200)
        ).body,
        blobs: (await migrationDataSource.getRepository(BlobEntity).findBy({ namespaceId }))
          .map((blob) => ({ id: blob.id, referenceCount: blob.referenceCount }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      const before = await read();
      const failedCopy = await request(httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'state-contract')
        .send({
          kind: 'copy',
          source: '/parent/file',
          destination: '/parent/copied',
          sourceRevision: before.root.revision,
          destinationAbsent: true,
        })
        .expect(412);
      expect(failedCopy.body.code).toBe('VFS_PRECONDITION_FAILED');
      const failedUpload = await request(httpServer)
        .post(`${base}/content/conditional`)
        .query({ path: '/parent/file' })
        .set('Content-Type', 'text/plain')
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'state-contract')
        .set('X-If-Revision', before.root.revision)
        .send('replacement')
        .expect(412);
      expect(failedUpload.body.code).toBe('VFS_PRECONDITION_FAILED');
      expect(await read()).toEqual(before);
      expect(
        (await request(httpServer).get(`${base}/content`).query({ path: '/parent/file' }).expect(200)).text,
      ).toBe('original');
      await request(httpServer).get(`${base}/revision`).query({ path: '/parent/copied' }).expect(404);
    });

    it('matches move and copy affectedRevisions to reads and invalidates changed directory cursors', async () => {
      const namespaceId = await createNamespace('conditional-move-copy-revisions-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of [
        '/src',
        '/dst',
        '/src/a',
        '/src/a/child',
        '/src/a/child/grandchild',
        '/src/b',
        '/src/c',
        '/dst/a',
        '/dst/b',
      ]) {
        await request(httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
      }
      const revision = async (path: string): Promise<string> =>
        (await request(httpServer).get(`${base}/revision`).query({ path }).expect(200)).body
          .revision as string;
      const cursor = async (path: string): Promise<string> => {
        const page = await request(httpServer)
          .get(`${base}/ls`)
          .query({ path, consistency: 'revision', limit: 1 })
          .expect(200);
        expect(page.body.nextCursor).toMatch(/^rc1\./);
        return page.body.nextCursor as string;
      };
      const expectStale = async (path: string, previousCursor: string): Promise<void> => {
        expect(
          (
            await request(httpServer)
              .get(`${base}/ls`)
              .query({ path, consistency: 'revision', limit: 1, cursor: previousCursor })
              .expect(412)
          ).body.code,
        ).toBe('VFS_PRECONDITION_FAILED');
      };
      const expectAffected = async (
        response: { affectedRevisions: { path: string; revision: string }[] },
        paths: string[],
      ): Promise<void> => {
        expect(response.affectedRevisions.map((entry) => entry.path).sort()).toEqual(paths);
        for (const path of paths) {
          const affected = response.affectedRevisions.find((entry) => entry.path === path);
          expect(affected).toEqual({ path, revision: await revision(path) });
        }
      };

      const sourceCursor = await cursor('/src');
      const destinationCursor = await cursor('/dst');
      const movedChildBefore = await revision('/src/a/child');
      const moved = await request(httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'revision-contract')
        .send({
          kind: 'move',
          source: '/src/a',
          destination: '/dst/moved',
          sourceRevision: await revision('/src/a'),
          destinationAbsent: true,
        })
        .expect(200);
      expect(moved.body.resource.path).toBe('/dst/moved');
      await expectAffected(moved.body, [
        '/',
        '/dst',
        '/dst/moved',
        '/dst/moved/child',
        '/dst/moved/child/grandchild',
        '/src',
      ]);
      expect(await revision('/dst/moved/child')).not.toBe(movedChildBefore);
      await request(httpServer).get(`${base}/revision`).query({ path: '/src/a' }).expect(404);
      await expectStale('/src', sourceCursor);
      await expectStale('/dst', destinationCursor);

      const copiedSourceRevision = await revision('/dst/moved');
      const copiedSourceChildRevision = await revision('/dst/moved/child');
      const nextSourceCursor = await cursor('/src');
      const copied = await request(httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'revision-contract')
        .send({
          kind: 'copy',
          source: '/dst/moved',
          destination: '/src/copied',
          sourceRevision: copiedSourceRevision,
          destinationAbsent: true,
        })
        .expect(201);
      expect(copied.body.resource.path).toBe('/src/copied');
      await expectAffected(copied.body, [
        '/',
        '/src',
        '/src/copied',
        '/src/copied/child',
        '/src/copied/child/grandchild',
      ]);
      expect(await revision('/dst/moved')).toBe(copiedSourceRevision);
      expect(await revision('/dst/moved/child')).toBe(copiedSourceChildRevision);
      await expectStale('/src', nextSourceCursor);
    });

    it('replays the exact JSON request without increasing revisions again', async () => {
      const namespaceId = await createNamespace('conditional-mkdir-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const key = randomUUID();
      const body = '{"kind":"mkdir","path":"/a","ifAbsent":true}';
      const send = (raw: string) =>
        request(httpServer)
          .post(base)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .send(raw);
      const first = await send(body).expect(201);
      expect(first.body).toMatchObject({ resource: { path: '/a' } });
      expect(first.body.affectedRevisions.map((item: { path: string }) => item.path)).toEqual(['/', '/a']);
      const replay = await send(body).expect(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      const changed = await send('{"kind":"mkdir", "path":"/a","ifAbsent":true}').expect(409);
      expect(changed.body.code).toBe('MUTATION_KEY_REUSED');
    });

    it('replays deterministic 428 and 400 responses with the original request ID', async () => {
      const namespaceId = await createNamespace('conditional-errors-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const key = randomUUID();
      const send = (body: string) =>
        request(httpServer)
          .post(base)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .send(body);
      const first = await send('{"kind":"mkdir","path":"/a"}').expect(428);
      expect(first.body.code).toBe('VFS_PRECONDITION_REQUIRED');
      const replay = await send('{"kind":"mkdir","path":"/a"}').expect(428);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      const changed = await send('{"kind":"mkdir","path":"/a","ifAbsent":true}').expect(409);
      expect(changed.body.code).toBe('MUTATION_KEY_REUSED');

      const brokenKey = randomUUID();
      const badRequest = () =>
        request(httpServer)
          .post(base)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', brokenKey)
          .set('X-Mutation-Scope', 'caller-a')
          .send('{broken');
      const broken = await badRequest().expect(400);
      expect((await badRequest().expect(400)).body).toEqual(broken.body);
    });

    it('조건 불일치 412를 최초 body(current 포함)로 재생하고 이후 변경에도 current를 고정한다', async () => {
      const namespaceId = await createNamespace('conditional-stale-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/a' }).expect(201);
      const root = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });
      const old = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: root.id, name: 'a' });
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/a/child' }).expect(201);
      const key = randomUUID();
      const send = (revision: string) =>
        request(httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .send({ kind: 'delete', path: '/a', ifRevision: revision, recursive: true });
      const statAt412 = (await request(httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200))
        .body;
      const revisionAt412 = (
        await request(httpServer).get(`${base}/revision`).query({ path: '/a' }).expect(200)
      ).body.revision as string;
      const failed = await send(encodeRevision(old)).expect(412);
      expect(failed.body).toMatchObject({
        code: 'VFS_PRECONDITION_FAILED',
        path: '/a',
        current: { ...withoutStatHash(statAt412), revision: revisionAt412 },
      });
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/a/later' }).expect(201);
      const statLater = (await request(httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200))
        .body;
      expect(statLater).not.toEqual(statAt412);
      // 자식 추가로 현재 revision이 바뀌어도 재생되는 current.revision은 충돌 시점 값이다.
      const revisionLater = (
        await request(httpServer).get(`${base}/revision`).query({ path: '/a' }).expect(200)
      ).body.revision as string;
      expect(revisionLater).not.toBe(revisionAt412);
      const replay = await send(encodeRevision(old)).expect(412);
      expect(replay.body).toEqual(failed.body);
      expect(replay.body.current.revision).toBe(revisionAt412);
      expect(replay.headers['x-request-id']).toBe(failed.headers['x-request-id']);
      const current = await migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: old.id });
      expect((await send(encodeRevision(current)).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
      const accepted = await request(httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'caller-a')
        .send({ kind: 'delete', path: '/a', ifRevision: encodeRevision(current), recursive: true })
        .expect(200);
      expect(accepted.body).toMatchObject({ resource: null });
      expect(accepted.body.affectedRevisions.map((item: { path: string }) => item.path)).toEqual(['/']);
    });

    it('requires UUID identity and bounded scope, and reports an active lease with Retry-After', async () => {
      const namespaceId = await createNamespace('conditional-identity-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const body = { kind: 'mkdir', path: '/a', ifAbsent: true };
      expect(
        (await request(httpServer).post(base).set('X-Mutation-Scope', 'caller-a').send(body).expect(400)).body
          .code,
      ).toBe('VFS_INVALID_MUTATION_REQUEST');
      expect(
        (
          await request(httpServer)
            .post(base)
            .set('Idempotency-Key', 'bad')
            .set('X-Mutation-Scope', 'caller-a')
            .send(body)
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_MUTATION_REQUEST');
      expect(
        (
          await request(httpServer)
            .post(base)
            .set('Idempotency-Key', randomUUID())
            .set('X-Mutation-Scope', 'x'.repeat(129))
            .send(body)
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_MUTATION_REQUEST');
      const key = randomUUID();
      await app.get(VfsMutationReceiptRepository).claim({ namespaceId, scope: 'caller-a', key }, new Date());
      const busy = await request(httpServer)
        .post(base)
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', 'caller-a')
        .send(body)
        .expect(409);
      expect(busy.body.code).toBe('MUTATION_IN_PROGRESS');
      expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('conditional content upload', () => {
    it('경쟁 생성의 승자 ID와 revision을 receipt·stat에 보존하고 교체·이동·재생성의 ID 경계를 지킨다', async () => {
      const namespaceId = await createNamespace('conditional-stable-id');
      const otherNamespaceId = await createNamespace('conditional-stable-id-other');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const upload = (key: string, bytes: Buffer, condition: Record<string, string>, path = '/doc') => {
        let call = request(httpServer)
          .post(`${base}/content/conditional`)
          .query({ path })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'stable-id')
          .set('Content-Type', 'application/octet-stream');
        for (const [name, value] of Object.entries(condition)) call = call.set(name, value);
        return call.send(bytes);
      };
      const firstKey = randomUUID();
      const secondKey = randomUUID();
      const [first, second] = await Promise.all([
        upload(firstKey, Buffer.from('first'), { 'X-If-Absent': 'true' }),
        upload(secondKey, Buffer.from('second'), { 'X-If-Absent': 'true' }),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 412]);
      const winner = first.status === 201 ? first : second;
      const winnerKey = first.status === 201 ? firstKey : secondKey;
      const winnerBytes = first.status === 201 ? Buffer.from('first') : Buffer.from('second');
      const stat = async (path: string) =>
        (await request(httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;
      const original = await stat('/doc');
      expect(winner.body.resource).toMatchObject({ id: original.id, revision: original.revision });
      expect(original).toMatchObject({
        path: '/doc',
        type: 'FILE',
        size: winnerBytes.length,
        mimeType: 'application/octet-stream',
      });
      expect(original.sha256).toBe(createHash('sha256').update(winnerBytes).digest('hex'));
      expect((await upload(winnerKey, winnerBytes, { 'X-If-Absent': 'true' }).expect(201)).body).toEqual(
        winner.body,
      );

      const empty = await upload(randomUUID(), Buffer.alloc(0), {
        'X-If-Revision': original.revision,
      }).expect(200);
      const replaced = await stat('/doc');
      expect(empty.body.resource).toMatchObject({ id: original.id, revision: replaced.revision });
      expect(replaced).toMatchObject({
        id: original.id,
        size: 0,
        sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      });
      expect(replaced.revision).not.toBe(original.revision);

      const moved = await request(httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'stable-id')
        .send({
          kind: 'move',
          source: '/doc',
          destination: '/renamed',
          sourceRevision: replaced.revision,
          destinationAbsent: true,
        })
        .expect(200);
      const movedStat = await stat('/renamed');
      expect(moved.body.resource).toMatchObject({ id: original.id, path: '/renamed' });
      expect(moved.body.affectedRevisions).toContainEqual({ path: '/renamed', revision: movedStat.revision });
      expect(movedStat.id).toBe(original.id);
      await request(httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'stable-id')
        .send({ kind: 'delete', path: '/renamed', ifRevision: movedStat.revision })
        .expect(200);
      await request(httpServer).get(`${base}/stat`).query({ path: '/renamed' }).expect(404);
      await request(httpServer)
        .get(`/api/v2/namespaces/${otherNamespaceId}/fs/stat`)
        .query({ path: '/renamed' })
        .expect(404);
      const recreatedBytes = Buffer.from('recreated');
      const recreated = await upload(
        randomUUID(),
        recreatedBytes,
        { 'X-If-Absent': 'true' },
        '/renamed',
      ).expect(201);
      const recreatedStat = await stat('/renamed');
      expect(recreated.body.resource).toMatchObject({
        id: recreatedStat.id,
        revision: recreatedStat.revision,
      });
      expect(recreatedStat).toMatchObject({
        type: 'FILE',
        size: recreatedBytes.length,
        sha256: createHash('sha256').update(recreatedBytes).digest('hex'),
      });
      expect(recreatedStat.id).not.toBe(original.id);
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      expect(await stat('/dir')).toMatchObject({ type: 'DIRECTORY', sha256: null });
    });

    it('NFD path 거부를 receipt로 재생하고 같은 key의 NFC upload는 key 재사용으로 거부한다', async () => {
      const namespaceId = await createNamespace('conditional-content-nfd-retry-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const key = randomUUID();
      const send = (path: string, idempotencyKey = key) =>
        request(httpServer)
          .post(base)
          .query({ path })
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('body'));
      const rejected = await send('/e\u0301').expect(400);
      expect(rejected.body.code).toBe('VFS_INVALID_PATH');
      expect(
        await migrationDataSource.getRepository(VfsMutationReceiptEntity).findBy({ namespaceId }),
      ).toMatchObject([{ state: 'COMPLETE', responseStatus: 400 }]);
      expect(await migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(0);
      const replay = await send('/e\u0301').expect(400);
      expect(replay.body).toEqual(rejected.body);
      expect(replay.headers['x-request-id']).toBe(rejected.headers['x-request-id']);
      expect((await send('/é').expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
      const accepted = await send('/é', randomUUID()).expect(201);
      expect(accepted.body.resource.path).toBe('/é');
    });

    it('replays an accepted upload after the namespace file-size limit is lowered', async () => {
      const namespaceId = await createNamespace('conditional-content-replay-limit-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const bytes = Buffer.from('accepted before the limit changed');
      const key = randomUUID();
      const send = () =>
        request(httpServer)
          .post(base)
          .query({ path: '/code.py' })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(bytes);
      const first = await send().expect(201);
      await migrationDataSource.getRepository(NamespaceEntity).update(namespaceId, { maxFileSizeBytes: '1' });
      const replay = await send().expect(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    });

    it('stores binary bytes and replays the exact upload without another Blob row', async () => {
      const namespaceId = await createNamespace('conditional-content-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const key = randomUUID();
      const bytes = Buffer.from([0, 1, 2, 255, 0, 128]);
      const send = (value: Buffer) =>
        request(httpServer)
          .post(`${base}/content/conditional`)
          .query({ path: '/image.bin' })
          .set('Content-Type', 'application/octet-stream')
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .send(value);
      const first = await send(bytes).expect(201);
      expect(first.body).toMatchObject({ resource: { path: '/image.bin' } });
      const blobCount = await migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } });
      const storage = app.get<BlobStorage>(BLOB_STORAGE);
      const putSpy = jest.spyOn(storage, 'put');
      try {
        const replay = await send(bytes).expect(201);
        expect(replay.body).toEqual(first.body);
        expect(putSpy).not.toHaveBeenCalled();
      } finally {
        putSpy.mockRestore();
      }
      expect(await migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(
        blobCount,
      );
      const downloaded = await request(httpServer)
        .get(`${base}/content`)
        .query({ path: '/image.bin' })
        .expect(200);
      expect(downloaded.body).toEqual(bytes);
    });

    it('교체는 정확한 revision을 요구하고 최초 412는 파일 교체 뒤에도 충돌 시점 current로 재생하며 fingerprint가 바뀐 재시도는 거부한다', async () => {
      const namespaceId = await createNamespace('conditional-content-replace-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const createKey = randomUUID();
      const put = (
        key: string,
        path: string,
        mime: string,
        bytes: Buffer,
        condition: Record<string, string>,
      ) => {
        let call = request(httpServer)
          .post(base)
          .query({ path })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('Content-Type', mime);
        for (const [name, value] of Object.entries(condition)) call = call.set(name, value);
        return call.send(bytes);
      };
      const created = await put(createKey, '/x', 'text/plain', Buffer.from('first'), {
        'X-If-Absent': 'true',
      }).expect(201);
      const revision = created.body.affectedRevisions.find((item: { path: string }) => item.path === '/x')
        .revision as string;
      const root = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });
      const staleKey = randomUUID();
      const sendStale = () =>
        put(staleKey, '/x', 'text/plain', Buffer.from('second'), {
          'X-If-Revision': encodeRevision(root),
        });
      const blobCount = () => migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } });
      const storage = app.get<BlobStorage>(BLOB_STORAGE);
      const blobsBeforeStale = await blobCount();
      const putSpy = jest.spyOn(storage, 'put');
      const deleteSpy = jest.spyOn(storage, 'delete');
      let stale: request.Response;
      try {
        stale = await sendStale().expect(412);
        // 412로 롤백되면 업로드한 object를 지우고 Blob row도 남기지 않는다.
        expect(putSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).toHaveBeenCalledWith(putSpy.mock.calls[0][0]);
      } finally {
        putSpy.mockRestore();
        deleteSpy.mockRestore();
      }
      expect(await blobCount()).toBe(blobsBeforeStale);
      expect(stale.body.code).toBe('VFS_PRECONDITION_FAILED');
      expect(stale.body.current).toMatchObject({ path: '/x', type: 'FILE', size: 5, revision });
      const replaceKey = randomUUID();
      const replaced = await put(replaceKey, '/x', 'text/plain', Buffer.from('second'), {
        'X-If-Revision': revision,
      }).expect(200);
      expect(replaced.body.resource.path).toBe('/x');
      expect(
        (
          await request(httpServer)
            .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
            .query({ path: '/x' })
            .expect(200)
        ).text,
      ).toBe('second');
      const blobsBeforeReplay = await blobCount();
      const replayPutSpy = jest.spyOn(storage, 'put');
      let staleReplay: request.Response;
      try {
        staleReplay = await sendStale().expect(412);
        // 412 재생은 body를 hash만 하고 업로드하지 않는다.
        expect(replayPutSpy).not.toHaveBeenCalled();
      } finally {
        replayPutSpy.mockRestore();
      }
      expect(await blobCount()).toBe(blobsBeforeReplay);
      expect(staleReplay.body).toEqual(stale.body);
      // 파일이 교체된 뒤에도 재생된 current.revision은 충돌 시점 revision이다.
      expect(staleReplay.body.current.revision).toBe(revision);
      expect(
        (
          await request(httpServer)
            .get(`/api/v2/namespaces/${namespaceId}/fs/revision`)
            .query({ path: '/x' })
            .expect(200)
        ).body.revision,
      ).not.toBe(revision);
      expect(staleReplay.headers['x-request-id']).toBe(stale.headers['x-request-id']);
      expect(
        (
          await put(staleKey, '/x', 'text/plain', Buffer.from('second'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/x', 'text/plain', Buffer.from('other'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/x', 'application/octet-stream', Buffer.from('second'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/y', 'text/plain', Buffer.from('second'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/x', 'text/plain', Buffer.from('second'), { 'X-If-Absent': 'true' }).expect(
            409,
          )
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
    });

    it('부모 부재 404를 receipt로 재생해 부모 생성 뒤에도 같은 key는 404를 받는다', async () => {
      const namespaceId = await createNamespace('conditional-content-parent-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const key = randomUUID();
      const send = (idempotencyKey = key) =>
        request(httpServer)
          .post(`${base}/content/conditional`)
          .query({ path: '/parent/x' })
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'text/plain')
          .send(Buffer.from('content'));
      const missing = await send().expect(404);
      expect(missing.body.code).toBe('VFS_NODE_NOT_FOUND');
      expect(await migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(0);
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/parent' }).expect(201);
      const replay = await send().expect(404);
      expect(replay.body).toEqual(missing.body);
      expect(replay.headers['x-request-id']).toBe(missing.headers['x-request-id']);
      await send(randomUUID()).expect(201);
    });

    it('requires a condition and does not freeze a 413 response', async () => {
      const namespaceId = await createNamespace('conditional-content-limit-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const key = randomUUID();
      const missing = await request(httpServer)
        .post(base)
        .query({ path: '/x' })
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', 'caller-a')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('small'))
        .expect(428);
      expect(missing.body.code).toBe('VFS_PRECONDITION_REQUIRED');
      const tooLargeKey = randomUUID();
      const send = (bytes: Buffer) =>
        request(httpServer)
          .post(base)
          .query({ path: '/big' })
          .set('Idempotency-Key', tooLargeKey)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(bytes);
      expect((await send(Buffer.alloc(MAX_FILE_SIZE_BYTES + 1)).expect(413)).body.code).toBe(
        'VFS_FILE_TOO_LARGE',
      );
      expect((await send(Buffer.from('ok')).expect(201)).body.resource.path).toBe('/big');
      const chunkedKey = randomUUID();
      const chunked = await postChunked(
        serverPort,
        `${base}?path=/chunked`,
        [Buffer.alloc(MAX_FILE_SIZE_BYTES), Buffer.from([1])],
        { 'Idempotency-Key': chunkedKey, 'X-Mutation-Scope': 'caller-a', 'X-If-Absent': 'true' },
      );
      expect(chunked.status).toBe(413);
      // Content-Length 없는 스트리밍 413도 저장되지 않으므로 같은 key의 작은 본문은 새로 평가된다.
      expect(
        await migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: chunkedKey }),
      ).toBeNull();
      const retried = await postChunked(serverPort, `${base}?path=/chunked`, [Buffer.from('ok')], {
        'Idempotency-Key': chunkedKey,
        'X-Mutation-Scope': 'caller-a',
        'X-If-Absent': 'true',
      });
      expect(retried.status).toBe(201);
      expect(retried.body).toMatchObject({ resource: { path: '/chunked' } });
    });

    it('renews a short lease while an upload waits for more chunks', async () => {
      const previous = process.env.STORIX_MUTATION_LEASE_SECONDS;
      process.env.STORIX_MUTATION_LEASE_SECONDS = '2';
      const namespaceId = await createNamespace('conditional-content-renew-ns');
      const key = randomUUID();
      const held = startHeldUpload(
        serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content/conditional?path=/held`,
        { 'Idempotency-Key': key, 'X-Mutation-Scope': 'caller-a', 'X-If-Absent': 'true' },
      );
      try {
        held.req.write(Buffer.from('first'));
        let receipt: VfsMutationReceiptEntity | null = null;
        for (let attempt = 0; attempt < 100 && !receipt; attempt += 1) {
          receipt = await migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: key });
          if (!receipt) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(receipt).not.toBeNull();
        expect(receipt!.leaseExpiresAt!.getTime() - Date.now()).toBeLessThan(3000);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const renewed = await migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .findOneByOrFail({ namespaceId, scope: 'caller-a', idempotencyKey: key });
        expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
        held.req.end(Buffer.from('second'));
        expect((await held.response).status).toBe(201);
      } finally {
        void held.response.catch(() => undefined);
        held.req.destroy();
        if (previous === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
        else process.env.STORIX_MUTATION_LEASE_SECONDS = previous;
      }
    });

    it('renews a short lease while hashing a malformed conditional content body', async () => {
      const previous = process.env.STORIX_MUTATION_LEASE_SECONDS;
      process.env.STORIX_MUTATION_LEASE_SECONDS = '2';
      let held: ReturnType<typeof startHeldUpload> | undefined;
      try {
        const namespaceId = await createNamespace('conditional-content-invalid-renew-ns');
        const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
        const key = randomUUID();
        const headers = {
          'Idempotency-Key': key,
          'X-Mutation-Scope': 'caller-a',
          'X-If-Revision': 'bad',
        };
        const body = Buffer.from('firstsecond');
        held = startHeldUpload(serverPort, `${base}?path=/invalid-held`, headers);
        held.req.write(Buffer.from('first'));

        let receipt: VfsMutationReceiptEntity | null = null;
        for (let attempt = 0; attempt < 100 && !receipt; attempt += 1) {
          receipt = await migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: key });
          if (!receipt) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(receipt).not.toBeNull();
        expect(receipt!.state).toBe('RESERVED');

        // 해시가 진행되는 동안 원래 lease가 만료됐어야 하는 시간보다 길게 기다린다.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const whileHashing = await request(httpServer)
          .post(base)
          .query({ path: '/invalid-held' })
          .set(headers)
          .set('Content-Type', 'application/octet-stream')
          .send(body)
          .expect(409);
        expect(whileHashing.body.code).toBe('MUTATION_IN_PROGRESS');

        held.req.end(Buffer.from('second'));
        const rejected = await held.response;
        expect(rejected.status).toBe(400);
        expect(rejected.body).toMatchObject({ code: 'VFS_INVALID_REVISION' });
        const replay = await request(httpServer)
          .post(base)
          .query({ path: '/invalid-held' })
          .set(headers)
          .set('Content-Type', 'application/octet-stream')
          .send(body)
          .expect(400);
        expect(replay.body).toEqual(rejected.body);
        expect(replay.headers['x-request-id']).toBe(rejected.headers['x-request-id']);
      } finally {
        if (held) {
          void held.response.catch(() => undefined);
          held.req.destroy();
        }
        if (previous === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
        else process.env.STORIX_MUTATION_LEASE_SECONDS = previous;
      }
    });

    it('fences an upload owner whose lease was taken over before commit', async () => {
      const namespaceId = await createNamespace('conditional-content-fence-ns');
      const key = randomUUID();
      const held = startHeldUpload(
        serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content/conditional?path=/fenced`,
        { 'Idempotency-Key': key, 'X-Mutation-Scope': 'caller-a', 'X-If-Absent': 'true' },
      );
      try {
        held.req.write(Buffer.from('first'));
        let receipt: VfsMutationReceiptEntity | null = null;
        for (let attempt = 0; attempt < 100 && !receipt; attempt += 1) {
          receipt = await migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: key });
          if (!receipt) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(receipt).not.toBeNull();
        const takeover = await app
          .get(VfsMutationReceiptRepository)
          .claim({ namespaceId, scope: 'caller-a', key }, new Date(receipt!.leaseExpiresAt!.getTime() + 1));
        expect(takeover).toEqual({ kind: 'owner', generation: 2 });
        held.req.end(Buffer.from('second'));
        expect((await held.response).status).toBe(500);
        const root = await migrationDataSource
          .getRepository(VfsNodeEntity)
          .findOneByOrFail({ namespaceId, parentId: IsNull() });
        expect(
          await migrationDataSource
            .getRepository(VfsNodeEntity)
            .findOneBy({ namespaceId, parentId: root.id, name: 'fenced' }),
        ).toBeNull();
      } finally {
        void held.response.catch(() => undefined);
        held.req.destroy();
      }
    });

    it('serializes same-path conditional creates to one 201 and one 412', async () => {
      const namespaceId = await createNamespace('conditional-content-race-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const send = (key: string) =>
        request(httpServer)
          .post(base)
          .query({ path: '/same' })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('race'));
      const responses = await Promise.all([send(randomUUID()), send(randomUUID())]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
      expect(await migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(1);
    });
  });

  describe('결정적 4xx 오류 receipt', () => {
    const scope = 'error-receipt';
    const mutate = (namespaceId: string, key: string, body: string) =>
      request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mutations`)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', scope)
        .send(body);
    const upload = (
      namespaceId: string,
      key: string,
      path: string,
      headers: Record<string, string>,
      bytes = Buffer.from('body'),
    ) => {
      let call = request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content/conditional`)
        .query({ path })
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', scope)
        .set('Content-Type', 'application/octet-stream');
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      return call.send(bytes);
    };
    const receiptOf = (namespaceId: string, key: string) =>
      migrationDataSource
        .getRepository(VfsMutationReceiptEntity)
        .findOneBy({ namespaceId, scope, idempotencyKey: key });

    it('미분류·분류된 DB 5xx는 receipt 없이 같은 key에서 재평가하고 한 번만 변경한다', async () => {
      const namespaceId = await createNamespace('error-receipt-transient');
      const nodes = app.get(VfsNodeRepository);
      const jsonKey = randomUUID();
      const jsonBody = '{"kind":"mkdir","path":"/a","ifAbsent":true}';
      const jsonSpy = jest
        .spyOn(nodes, 'applyConditionalMutation')
        .mockRejectedValueOnce(new Error('injected database failure'))
        .mockRejectedValueOnce(new InjectedUnavailableError())
        .mockRejectedValueOnce({ driverError: { code: '08006', message: 'private database endpoint' } });
      try {
        expect((await mutate(namespaceId, jsonKey, jsonBody).expect(500)).body.code).toBe('INTERNAL_ERROR');
        expect(await receiptOf(namespaceId, jsonKey)).toBeNull();
        await mutate(namespaceId, jsonKey, jsonBody).expect(503);
        expect(await receiptOf(namespaceId, jsonKey)).toBeNull();
        const unavailable = await mutate(namespaceId, jsonKey, jsonBody).expect(503);
        expect(unavailable.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
        expect(JSON.stringify(unavailable.body)).not.toContain('private database endpoint');
        expect(await receiptOf(namespaceId, jsonKey)).toBeNull();
      } finally {
        jsonSpy.mockRestore();
      }
      const created = await mutate(namespaceId, jsonKey, jsonBody).expect(201);
      expect(created.body.resource.path).toBe('/a');
      const replay = await mutate(namespaceId, jsonKey, jsonBody).expect(201);
      expect(replay.body).toEqual(created.body);
      expect(await receiptOf(namespaceId, jsonKey)).toMatchObject({ state: 'COMPLETE' });
      expect(await migrationDataSource.getRepository(VfsNodeEntity).countBy({ namespaceId, name: 'a' })).toBe(1);

      const uploadKey = randomUUID();
      const contentSpy = jest
        .spyOn(nodes, 'putConditionalContent')
        .mockRejectedValueOnce(new Error('injected database failure'));
      try {
        await upload(namespaceId, uploadKey, '/a/file', { 'X-If-Absent': 'true' }).expect(500);
      } finally {
        contentSpy.mockRestore();
      }
      expect(await receiptOf(namespaceId, uploadKey)).toBeNull();
      expect(await migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(0);
      expect(
        (await upload(namespaceId, uploadKey, '/a/file', { 'X-If-Absent': 'true' }).expect(201)).body.resource
          .path,
      ).toBe('/a/file');
    });

    it('MinIO SDK 일시·영구 실패는 안전한 코드로 응답하고 일시 실패는 같은 key로 성공한다', async () => {
      const namespaceId = await createNamespace('error-receipt-blob-sdk');
      const client = app.get<MinioClient>(STORAGE_CLIENT);
      const putSpy = jest.spyOn(client, 'putObject');
      const transientKey = randomUUID();
      const permanentKey = randomUUID();
      try {
        putSpy.mockRejectedValueOnce(Object.assign(new Error('private blob endpoint'), { code: 'ECONNRESET' }));
        const transient = await upload(namespaceId, transientKey, '/transient', { 'X-If-Absent': 'true' }).expect(503);
        expect(transient.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
        expect(JSON.stringify(transient.body)).not.toContain('private blob endpoint');
        expect(await receiptOf(namespaceId, transientKey)).toBeNull();
        expect(await migrationDataSource.getRepository(BlobEntity).countBy({ namespaceId })).toBe(0);
        putSpy.mockRestore();

        const created = await upload(namespaceId, transientKey, '/transient', { 'X-If-Absent': 'true' }).expect(201);
        expect(created.body.resource.path).toBe('/transient');
        expect((await upload(namespaceId, transientKey, '/transient', { 'X-If-Absent': 'true' }).expect(201)).body)
          .toEqual(created.body);
        expect(await receiptOf(namespaceId, transientKey)).toMatchObject({ state: 'COMPLETE' });
        expect(await migrationDataSource.getRepository(VfsNodeEntity).countBy({ namespaceId, name: 'transient' }))
          .toBe(1);

        const permanentSpy = jest.spyOn(client, 'putObject').mockRejectedValueOnce(
          Object.assign(new S3Error('private object key'), { code: 'AccessDenied' }),
        );
        try {
          const permanent = await upload(namespaceId, permanentKey, '/permanent', { 'X-If-Absent': 'true' }).expect(500);
          expect(permanent.body).toMatchObject({ code: 'STORAGE_FAILURE' });
          expect(JSON.stringify(permanent.body)).not.toContain('private object key');
          expect(await receiptOf(namespaceId, permanentKey)).toBeNull();
        } finally {
          permanentSpy.mockRestore();
        }
      } finally {
        putSpy.mockRestore();
      }
    });

    it('진행 중 claim은 응답을 저장하지 않고 lease 만료 뒤 같은 key로 처리한다', async () => {
      // lease를 5초로 두고 claim 직후 요청해 busy 판정까지 5초 여유를 둔다.
      // 만료 대기는 저장된 lease 만료 시각을 기준으로 계산해 시계 지연에 흔들리지 않는다.
      const previous = process.env.STORIX_MUTATION_LEASE_SECONDS;
      process.env.STORIX_MUTATION_LEASE_SECONDS = '5';
      try {
        const namespaceId = await createNamespace('error-receipt-in-progress');
        const key = randomUUID();
        const body = '{"kind":"mkdir","path":"/a","ifAbsent":true}';
        await app.get(VfsMutationReceiptRepository).claim({ namespaceId, scope, key }, new Date());
        const busy = await mutate(namespaceId, key, body).expect(409);
        expect(busy.body.code).toBe('MUTATION_IN_PROGRESS');
        const reserved = await receiptOf(namespaceId, key);
        expect(reserved).toMatchObject({
          state: 'RESERVED',
          generation: 1,
          responseStatus: null,
          responseBody: null,
        });
        const waitMs = reserved!.leaseExpiresAt!.getTime() - Date.now() + 300;
        await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
        const accepted = await mutate(namespaceId, key, body).expect(201);
        expect(await receiptOf(namespaceId, key)).toMatchObject({
          state: 'COMPLETE',
          generation: 2,
          responseStatus: 201,
        });
        expect((await mutate(namespaceId, key, body).expect(201)).body).toEqual(accepted.body);
      } finally {
        if (previous === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
        else process.env.STORIX_MUTATION_LEASE_SECONDS = previous;
      }
    });

    it('content의 잘못된 조건 헤더 조합과 원본 경로는 같은 key에서 서로의 오류를 재생하지 않는다', async () => {
      const namespaceId = await createNamespace('error-receipt-content-headers');
      const missingKey = randomUUID();
      const missing = await upload(namespaceId, missingKey, '/x', {}).expect(428);
      expect(missing.body.code).toBe('VFS_PRECONDITION_REQUIRED');
      for (const headers of [{ 'X-If-Absent': 'false' }, { 'X-If-Revision': 'bad' }] as Record<
        string,
        string
      >[]) {
        expect((await upload(namespaceId, missingKey, '/x', headers).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
      }
      const missingReplay = await upload(namespaceId, missingKey, '/x', {}).expect(428);
      expect(missingReplay.body).toEqual(missing.body);
      expect(missingReplay.headers['x-request-id']).toBe(missing.headers['x-request-id']);

      const invalidKey = randomUUID();
      const invalid = await upload(namespaceId, invalidKey, '/x', { 'X-If-Absent': 'yes' }).expect(400);
      expect(invalid.body.code).toBe('VFS_INVALID_MUTATION_REQUEST');
      for (const headers of [
        { 'X-If-Absent': 'false' },
        { 'X-If-Absent': 'true', 'X-If-Revision': encodeRevision({ id: randomUUID(), version: 1 }) },
        { 'X-If-Revision': 'bad' },
      ] as Record<string, string>[]) {
        expect((await upload(namespaceId, invalidKey, '/x', headers).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
      }
      expect(
        (await upload(namespaceId, invalidKey, '/x', { 'X-If-Absent': 'yes' }).expect(400)).body,
      ).toEqual(invalid.body);

      const pathKey = randomUUID();
      const nfd = await upload(namespaceId, pathKey, '/e\u0301', { 'X-If-Absent': 'true' }).expect(400);
      expect(nfd.body.code).toBe('VFS_INVALID_PATH');
      expect(
        (await upload(namespaceId, pathKey, '/a\u0301', { 'X-If-Absent': 'true' }).expect(409)).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (await upload(namespaceId, pathKey, '/e\u0301', { 'X-If-Absent': 'true' }).expect(400)).body,
      ).toEqual(nfd.body);
    });

    it('JSON mutation·content·snapshot 오류 receipt를 PostgreSQL 앱 재시작 뒤 최초 body와 X-Request-Id로 재생한다', async () => {
      const namespaceId = await createNamespace('error-receipt-pg-restart');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/doc' })
        .set('Content-Type', 'text/plain')
        .send('first')
        .expect(201);
      const staleRevision = encodeRevision({ id: randomUUID(), version: 1 });
      const statAtConflict = (
        await request(httpServer).get(`${base}/stat`).query({ path: '/doc' }).expect(200)
      ).body;
      const revisionAtConflict = (
        await request(httpServer).get(`${base}/revision`).query({ path: '/doc' }).expect(200)
      ).body.revision as string;
      const expectedCurrent = { ...withoutStatHash(statAtConflict), revision: revisionAtConflict };
      const jsonKey = randomUUID();
      const jsonBody = JSON.stringify({ kind: 'delete', path: '/doc', ifRevision: staleRevision });
      const jsonFailed = await mutate(namespaceId, jsonKey, jsonBody).expect(412);
      expect(jsonFailed.body.current).toEqual(expectedCurrent);
      const uploadKey = randomUUID();
      const uploadFailed = await upload(namespaceId, uploadKey, '/doc', { 'X-If-Absent': 'true' }).expect(
        412,
      );
      expect(uploadFailed.body.current).toEqual(expectedCurrent);
      const snapshotKey = randomUUID();
      const snapshotBody = '{"kind":"file","path":"/missing"}';
      const snapshotRequest = () =>
        request(httpServer)
          .post(`${base}/snapshots`)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', snapshotKey)
          .set('X-Mutation-Scope', scope)
          .send(snapshotBody);
      const snapshotFailed = await snapshotRequest().expect(404);

      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/doc', force: true })
        .set('Content-Type', 'text/plain')
        .send('changed after the conflict')
        .expect(200);
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/missing' })
        .set('Content-Type', 'text/plain')
        .send('now present')
        .expect(201);
      const oldDataSource = app.get(DataSource);
      await app.close();
      expect(oldDataSource.isInitialized).toBe(false);
      await bootstrap();

      for (const [send, original] of [
        [() => mutate(namespaceId, jsonKey, jsonBody), jsonFailed],
        [() => upload(namespaceId, uploadKey, '/doc', { 'X-If-Absent': 'true' }), uploadFailed],
        [snapshotRequest, snapshotFailed],
      ] as const) {
        const replay = await send().expect(original.status);
        expect(replay.body).toEqual(original.body);
        expect(replay.headers['x-request-id']).toBe(original.headers['x-request-id']);
      }
      expect(jsonFailed.body.current.revision).toBe(revisionAtConflict);
      expect(
        (await request(httpServer).get(`${base}/stat`).query({ path: '/doc' }).expect(200)).body,
      ).not.toEqual(statAtConflict);
      expect(
        (await request(httpServer).get(`${base}/revision`).query({ path: '/doc' }).expect(200)).body.revision,
      ).not.toBe(revisionAtConflict);
      expect(
        (
          await mutate(
            namespaceId,
            jsonKey,
            JSON.stringify({ kind: 'delete', path: '/doc', ifRevision: 'x' }),
          ).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await upload(
            namespaceId,
            uploadKey,
            '/doc',
            { 'X-If-Absent': 'true' },
            Buffer.from('other'),
          ).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
    });
  });

  describe('revision reads and listing', () => {
    it('uses a read revision to conditionally delete a file', async () => {
      const namespaceId = await createNamespace('revision-delete-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(httpServer).post(`${base}/touch`).send({ path: '/code.py' }).expect(201);
      const read = await request(httpServer).get(`${base}/revision`).query({ path: '/code.py' }).expect(200);
      expect(read.body).toEqual({ path: '/code.py', revision: expect.stringMatching(/^r1\./) });
      await request(httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'revision-read-test')
        .send({ kind: 'delete', path: '/code.py', ifRevision: read.body.revision })
        .expect(200);
      expect(
        (await request(httpServer).get(`${base}/revision`).query({ path: '/code.py' }).expect(404)).body.code,
      ).toBe('VFS_NODE_NOT_FOUND');
    });

    it('returns opaque revisions without changing the legacy listing shape', async () => {
      const namespaceId = await createNamespace('revision-read-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const rootBefore = await request(httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200);
      expect(rootBefore.body).toMatchObject({ path: '/', revision: expect.stringMatching(/^r1\./) });
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/a' }).expect(201);
      const rootAfter = await request(httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200);
      expect(rootAfter.body.revision).not.toBe(rootBefore.body.revision);
      const listing = await request(httpServer)
        .get(`${base}/ls`)
        .query({ path: '/', consistency: 'revision' })
        .expect(200);
      expect(listing.body.directoryRevision).toBe(rootAfter.body.revision);
      expect(listing.body.items[0]).toMatchObject({ path: '/a', revision: expect.stringMatching(/^r1\./) });
      const legacy = await request(httpServer).get(`${base}/ls`).query({ path: '/' }).expect(200);
      expect(legacy.body).not.toHaveProperty('directoryRevision');
      expect(legacy.body.items[0]).not.toHaveProperty('revision');
    });

    it('rejects a cursor after descendant change but keeps it after an independent change', async () => {
      const namespaceId = await createNamespace('revision-cursor-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of ['/a', '/b', '/a/x', '/a/y']) {
        await request(httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
      }
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/a/x/code.py' })
        .set('Content-Type', 'text/plain')
        .send('first')
        .expect(201);
      const first = await request(httpServer)
        .get(`${base}/ls`)
        .query({ path: '/a', consistency: 'revision', limit: 1 })
        .expect(200);
      expect(first.body.nextCursor).toMatch(/^rc1\./);
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/b/other' }).expect(201);
      const second = await request(httpServer)
        .get(`${base}/ls`)
        .query({ path: '/a', consistency: 'revision', limit: 1, cursor: first.body.nextCursor })
        .expect(200);
      expect(second.body.items.map((item: { path: string }) => item.path)).toEqual(['/a/y']);
      expect(
        (
          await request(httpServer)
            .get(`${base}/ls`)
            .query({ path: '/b', consistency: 'revision', cursor: first.body.nextCursor })
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_CURSOR');
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path: '/a/x/code.py' })
        .set('Content-Type', 'text/plain')
        .set('If-Match', '1')
        .send('second')
        .expect(200);
      expect(
        (
          await request(httpServer)
            .get(`${base}/ls`)
            .query({ path: '/a', consistency: 'revision', limit: 1, cursor: first.body.nextCursor })
            .expect(412)
        ).body.code,
      ).toBe('VFS_PRECONDITION_FAILED');
    });

    it('rejects a malformed cursor and one from a deleted and recreated directory', async () => {
      const namespaceId = await createNamespace('revision-recreated-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of ['/dir', '/dir/a', '/dir/b']) {
        await request(httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
      }
      const first = await request(httpServer)
        .get(`${base}/ls`)
        .query({ path: '/dir', consistency: 'revision', limit: 1 })
        .expect(200);
      expect(
        (
          await request(httpServer)
            .get(`${base}/ls`)
            .query({ path: '/dir', consistency: 'revision', cursor: 'rc1.bad' })
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_CURSOR');
      await request(httpServer).post(`${base}/rm`).query({ path: '/dir', recursive: 'true' }).expect(204);
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      expect(
        (
          await request(httpServer)
            .get(`${base}/ls`)
            .query({ path: '/dir', consistency: 'revision', cursor: first.body.nextCursor })
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_CURSOR');
    });
  });

  describe('공통 검증', () => {
    it('존재하지 않는 namespace는 404를 반환한다', async () => {
      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${randomUUID()}/fs/stat`)
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
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/a/../b' })
        .expect(400);

      expect(response.body).toEqual({
        code: 'VFS_INVALID_PATH',
        message: expect.any(String),
        path: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('복수 query path를 500 대신 400 VFS_INVALID_PATH로 거부한다', async () => {
      const namespaceId = await createNamespace('invalid-query-path-ns');
      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat?path=%2Fa&path=%2Fb`)
        .expect(400);
      expect(response.body.code).toBe('VFS_INVALID_PATH');
    });

    it('일반 파일 경로도 alias를 정규화하고 NFD·길이 초과를 무변경으로 거부한다', async () => {
      const namespaceId = await createNamespace('global-path-contract-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(httpServer).post(`${base}/mkdir`).send({ path: '/a//./b/', parents: true }).expect(201);
      await request(httpServer).get(`${base}/stat`).query({ path: '/a/b' }).expect(200);

      for (const path of ['/e\u0301', `/${'가'.repeat(86)}`, '/a\u0085', '/a\u202e']) {
        expect(
          (await request(httpServer).post(`${base}/mkdir`).send({ path, parents: true }).expect(400)).body
            .code,
        ).toBe('VFS_INVALID_PATH');
      }
      expect(
        (await request(httpServer).get(`${base}/ls`).query({ path: '/' }).expect(200)).body.items.map(
          (x: { name: string }) => x.name,
        ),
      ).toEqual(['a']);
    });

    it('이동 결과 경로만 4096바이트를 넘으면 기존 파일을 보존한다', async () => {
      const namespaceId = await createNamespace('result-path-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const destination = `/${[...Array(15).fill('a'.repeat(255)), 'a'.repeat(254)].join('/')}`;
      await request(httpServer).post(`${base}/mkdir`).send({ path: destination, parents: true }).expect(201);
      await request(httpServer).post(`${base}/touch`).send({ path: '/a' }).expect(201);

      expect(
        (await request(httpServer).post(`${base}/mv`).send({ source: '/a', destination }).expect(400)).body
          .code,
      ).toBe('VFS_INVALID_PATH');
      await request(httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200);
      expect(
        (await request(httpServer).get(`${base}/ls`).query({ path: destination }).expect(200)).body.items,
      ).toEqual([]);
    });
  });

  describe('mkdir', () => {
    it('parents=false로 root 바로 아래 디렉터리를 생성하면 201을 반환한다', async () => {
      const namespaceId = await createNamespace('mkdir-basic-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/docs' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/docs', name: 'docs', type: 'DIRECTORY' });
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await createNamespace('mkdir-default-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('parents=true면 mkdir -p처럼 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespaceId = await createNamespace('mkdir-p-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b/c', parents: true })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a/b/c', name: 'c' });

      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a/b' })
        .expect(200);
    });

    it('이미 존재하는 디렉터리를 parents=false로 다시 만들면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await createNamespace('mkdir-conflict-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dup' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dup' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });
  });

  describe('ls', () => {
    it('name ASC, id ASC 순서로 자식을 나열한다', async () => {
      const namespaceId = await createNamespace('ls-order-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/b' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/' })
        .expect(200);

      expect(response.body.items.map((i: { name: string }) => i.name)).toEqual(['a', 'b']);
      expect(response.body.nextCursor).toBeNull();
    });

    it('limit을 넘는 항목이 있으면 nextCursor로 다음 페이지를 조회할 수 있다', async () => {
      const namespaceId = await createNamespace('ls-cursor-ns');
      for (const name of ['a', 'b', 'c']) {
        await request(httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
          .send({ path: `/${name}` })
          .expect(201);
      }

      const first = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', limit: 2 })
        .expect(200);

      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/', limit: 2, cursor: first.body.nextCursor })
        .expect(200);

      expect(second.body.items.map((i: { name: string }) => i.name)).toEqual(['c']);
      expect(second.body.nextCursor).toBeNull();
    });

    it('잘못된 형식의 cursor는 400 VFS_INVALID_CURSOR를 반환한다', async () => {
      const namespaceId = await createNamespace('ls-invalid-cursor-ns');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
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
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/file.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });

    it('존재하지 않는 경로는 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await createNamespace('ls-missing-ns');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/ls`)
        .query({ path: '/nope' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });
  });

  describe('stat / exists', () => {
    it('stat이 생성한 디렉터리 정보를 반환한다', async () => {
      const namespaceId = await createNamespace('stat-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(200);

      expect(response.body).toMatchObject({ path: '/a', name: 'a', type: 'DIRECTORY' });
    });

    it('exists는 없는 경로에 대해 404 대신 exists:false를 반환한다', async () => {
      const namespaceId = await createNamespace('exists-false-ns');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/exists`)
        .query({ path: '/nope' })
        .expect(200);

      expect(response.body).toEqual({ exists: false });
    });

    it('exists는 있는 경로에 대해 exists:true를 반환한다', async () => {
      const namespaceId = await createNamespace('exists-true-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/exists`)
        .query({ path: '/a' })
        .expect(200);

      expect(response.body).toEqual({ exists: true });
    });
  });

  describe('find', () => {
    it('시작 경로 하위를 재귀적으로 검색한다', async () => {
      const namespaceId = await createNamespace('find-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/' })
        .expect(200);

      expect(response.body.items.map((i: { path: string }) => i.path).sort()).toEqual(['/a', '/a/b']);
    });

    it('name/match/type 필터를 조합해 검색한다', async () => {
      const namespaceId = await createNamespace('find-filter-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/report-2026', parents: true })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/notes', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/find`)
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
        .get(`/api/v2/namespaces/${namespaceId}/fs/find`)
        .query({ path: '/file.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });
  });

  describe('touch', () => {
    it('없는 file을 0-byte로 생성하면 201을 반환한다', async () => {
      const namespaceId = await createNamespace('touch-create-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a.txt', name: 'a.txt', type: 'FILE', size: 0 });
    });

    it('parents 기본값은 false라서 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await createNamespace('touch-no-parent-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/b.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('parents=true면 중간 디렉터리를 생성하며 file을 만든다', async () => {
      const namespaceId = await createNamespace('touch-parents-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/b.txt', parents: true })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/a/b.txt', name: 'b.txt' });
    });

    it('기존 file을 다시 touch하면 200과 함께 version이 올라간다', async () => {
      const namespaceId = await createNamespace('touch-existing-ns');
      const first = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const second = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(200);

      expect(second.body.version).toBe(first.body.version + 1);
    });

    it('directory를 touch하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('touch-dir-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/adir' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });
  });

  describe('POST/GET content', () => {
    it('없는 file에 내용을 올리면 201과 함께 size/mimeType이 반영된다', async () => {
      const namespaceId = await createNamespace('put-create-ns');

      const putResponse = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      expect(putResponse.body).toMatchObject({ path: '/a.txt', size: 12, mimeType: 'text/plain' });

      const getResponse = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.text).toBe('hello storix');
      expect(getResponse.headers['content-type']).toBe('text/plain');
      const stat = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(getResponse.headers['x-storix-file-id']).toBe(stat.body.id);
      expect(getResponse.headers['x-storix-revision']).toBe(stat.body.revision);
      expect(getResponse.headers['x-storix-sha256']).toBe(
        createHash('sha256').update(getResponse.text).digest('hex'),
      );
      expect(getResponse.headers['x-storix-sha256']).toBe(stat.body.sha256);

      const range = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=0-4')
        .expect(206);
      expect(range.headers['x-storix-file-id']).toBeUndefined();
      expect(range.headers['x-storix-revision']).toBeUndefined();
      expect(range.headers['x-storix-sha256']).toBeUndefined();

      const download = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(download.text).toBe('hello storix');
      expect(download.headers['x-storix-file-id']).toBeUndefined();
      expect(download.headers['x-storix-revision']).toBeUndefined();
      expect(download.headers['x-storix-sha256']).toBeUndefined();
    });

    it('조회가 노드와 Blob을 읽은 뒤 교체되어도 이전 헤더와 이전 바이트를 함께 보낸다', async () => {
      const namespaceId = await createNamespace('content-read-replace-race');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const path = '/race.txt';
      const oldBytes = 'first content';
      const newBytes = 'replacement content';
      await request(httpServer)
        .post(`${base}/content`)
        .query({ path })
        .set('Content-Type', 'text/plain')
        .send(oldBytes)
        .expect(201);
      const oldStat = (await request(httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;

      const repo = app.get(VfsNodeRepository);
      const originalRead = repo.readContentFile.bind(repo);
      let signalCaptured!: () => void;
      let releaseRead!: () => void;
      const captured = new Promise<void>((resolve) => {
        signalCaptured = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let pauseOnce = true;
      const readSpy = jest
        .spyOn(repo, 'readContentFile')
        .mockImplementation(async (readNamespaceId, rootId, segments) => {
          const result = await originalRead(readNamespaceId, rootId, segments);
          if (pauseOnce && readNamespaceId === namespaceId && segments.join('/') === 'race.txt') {
            pauseOnce = false;
            signalCaptured();
            await held;
          }
          return result;
        });

      const pendingGet = request(httpServer)
        .get(`${base}/content`)
        .query({ path })
        .then((response) => response);
      try {
        await captured;
        await request(httpServer)
          .post(`${base}/content`)
          .query({ path, force: 'true' })
          .set('Content-Type', 'text/plain')
          .send(newBytes)
          .expect(200);
      } finally {
        releaseRead();
        readSpy.mockRestore();
      }

      const raced = await pendingGet;
      expect(raced.status).toBe(200);
      expect(raced.text).toBe(oldBytes);
      expect(raced.headers['x-storix-file-id']).toBe(oldStat.id);
      expect(raced.headers['x-storix-revision']).toBe(oldStat.revision);
      expect(raced.headers['x-storix-sha256']).toBe(createHash('sha256').update(oldBytes).digest('hex'));
      expect(raced.headers['x-storix-sha256']).toBe(oldStat.sha256);

      const currentStat = (await request(httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;
      const current = await request(httpServer).get(`${base}/content`).query({ path }).expect(200);
      expect(current.text).toBe(newBytes);
      expect(current.headers['x-storix-file-id']).toBe(oldStat.id);
      expect(current.headers['x-storix-file-id']).toBe(currentStat.id);
      expect(current.headers['x-storix-revision']).toBe(currentStat.revision);
      expect(current.headers['x-storix-revision']).not.toBe(oldStat.revision);
      expect(current.headers['x-storix-sha256']).toBe(createHash('sha256').update(newBytes).digest('hex'));
      expect(current.headers['x-storix-sha256']).toBe(currentStat.sha256);
    });

    it('GET content 응답에 nosniff와 CSP 헤더가 포함된다', async () => {
      // 공개 경로뿐 아니라 인증 경로도 sendContent()를 공유하므로 같은 하드닝
      // 헤더가 적용되는지 이 표면에서도 고정해 둔다.
      const namespaceId = await createNamespace('content-header-ns');

      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      const getResponse = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.headers['x-content-type-options']).toBe('nosniff');
      expect(getResponse.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    });

    it('같은 새 경로에 동시 업로드하면 하나만 생성하고 나머지는 version conflict를 반환한다', async () => {
      const namespaceId = await createNamespace('put-concurrent-create-ns');
      const path = '/same-path.txt';

      const responses = await Promise.all(
        ['first', 'second'].map((content) =>
          request(httpServer)
            .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
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
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a/b.txt' })
        .send('x')
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('directory 대상에 업로드하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('put-dir-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/adir' })
        .send('x')
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('If-Match 없이 기존 file을 덮어쓰려 하면 409 VFS_VERSION_CONFLICT를 반환한다', async () => {
      const namespaceId = await createNamespace('put-no-if-match-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v2')
        .expect(409);

      expect(response.body.code).toBe('VFS_VERSION_CONFLICT');
    });

    it('올바른 If-Match version이면 덮어쓴다', async () => {
      const namespaceId = await createNamespace('put-if-match-ns');
      const created = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const overwritten = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('If-Match', String(created.body.version))
        .send('version 2 content')
        .expect(200);

      expect(overwritten.body.size).toBe(Buffer.byteLength('version 2 content'));

      const getResponse = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);

      expect(getResponse.text).toBe('version 2 content');
      const stat = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(getResponse.headers['x-storix-file-id']).toBe(created.body.id);
      expect(getResponse.headers['x-storix-revision']).toBe(stat.body.revision);
      expect(getResponse.headers['x-storix-sha256']).toBe(stat.body.sha256);
    });

    it('force=true면 If-Match 없이도 덮어쓴다', async () => {
      const namespaceId = await createNamespace('put-force-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .send('v1')
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt', force: 'true' })
        .send('forced overwrite')
        .expect(200);

      expect(response.body.size).toBe(Buffer.byteLength('forced overwrite'));
    });

    it('Content-Type이 없으면 application/octet-stream으로 저장한다', async () => {
      const namespaceId = await createNamespace('put-default-mime-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.bin' })
        .send(Buffer.from([1, 2, 3]))
        .expect(201);

      expect(response.body.mimeType).toBe('application/octet-stream');
    });

    it('Content-Length가 STORIX_MAX_FILE_SIZE_BYTES를 넘으면 413 VFS_FILE_TOO_LARGE를 반환한다', async () => {
      const namespaceId = await createNamespace('put-length-too-large-ns');
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/big.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(oversized)
        .expect(413);

      expect(response.body.code).toBe('VFS_FILE_TOO_LARGE');
    });

    it('chunked stream이 STORIX_MAX_FILE_SIZE_BYTES를 넘으면 413 VFS_FILE_TOO_LARGE로 중단한다', async () => {
      const namespaceId = await createNamespace('put-chunked-too-large-ns');
      const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024, 1);
      const midpoint = Math.floor(oversized.length / 2);

      const response = await postChunked(
        serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big.bin')}`,
        [oversized.subarray(0, midpoint), oversized.subarray(midpoint)],
      );

      expect(response.status).toBe(413);
      expect((response.body as { code: string }).code).toBe('VFS_FILE_TOO_LARGE');
    });

    it('namespace의 max_file_size_bytes가 전역 한도보다 작으면 그 값을 넘는 요청을 413 VFS_FILE_TOO_LARGE로 거부한다', async () => {
      const namespaceId = await createNamespace('put-namespace-limit-ns');
      const namespaceLimit = 100;
      // 전역 한도(STORIX_MAX_FILE_SIZE_BYTES=1MiB)보다는 훨씬 작지만 namespace 한도보다는 큰
      // 크기로 요청해, 실제로 namespace 한도가 적용되는지(전역 한도만 걸리는 게 아닌지)를
      // HTTP 스택 전체(라우팅~DB~에러 필터)를 통해 검증한다.
      await migrationDataSource
        .getRepository(NamespaceEntity)
        .update(namespaceId, { maxFileSizeBytes: String(namespaceLimit) });
      const root = await migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/ns-limited.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(namespaceLimit + 1))
        .expect(413);

      expect(response.body.code).toBe('VFS_FILE_TOO_LARGE');
      expect(await migrationDataSource.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'ns-limited.bin' })).toBeNull();
      expect(await migrationDataSource.getRepository(BlobEntity).countBy({ namespaceId })).toBe(0);
      expect((await migrationDataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: root.id })).version).toBe(root.version);
      expect(String((await migrationDataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId })).liveFileByteCount)).toBe('0');
    });

    it('GET content 대상이 없으면 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await createNamespace('get-missing-ns');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/nope.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('GET content 대상이 directory면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('get-dir-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/adir' })
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/adir' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('빈 body로 POST content를 호출하면 0-byte file을 생성한다', async () => {
      const namespaceId = await createNamespace('put-empty-body-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/empty.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0))
        .expect(201);

      expect(response.body.size).toBe(0);

      const getResponse = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
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
          path: `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/aborted.bin')}`,
          method: 'POST',
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
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
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
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path })
        .set('Content-Type', 'text/plain')
        .send(text)
        .expect(201);
    }

    it('유효한 range는 206과 Content-Range를 반환한다', async () => {
      const namespaceId = await createNamespace('range-valid-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
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
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=5-')
        .expect(206);

      expect(response.text).toBe('56789');
    });

    it('suffix range(bytes=-3)는 마지막 N byte를 반환한다', async () => {
      const namespaceId = await createNamespace('range-suffix-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=-3')
        .expect(206);

      expect(response.text).toBe('789');
    });

    it('여러 range를 요청하면 416을 반환한다', async () => {
      const namespaceId = await createNamespace('range-multi-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Range', 'bytes=0-1,3-4')
        .expect(416);

      expect(response.body.code).toBe('VFS_RANGE_NOT_SATISFIABLE');
    });

    it('범위를 벗어난 range는 416을 반환한다', async () => {
      const namespaceId = await createNamespace('range-oob-ns');
      await putText(namespaceId, '/a.txt', '0123456789');

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
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
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/보고서.txt' })
        .set('Content-Type', 'text/plain')
        .send('내용')
        .expect(201);

      const response = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
        .query({ path: '/보고서.txt' })
        .expect(200);

      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="___.txt"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.txt`,
      );
    });

    it('다운로드 도중 클라이언트가 연결을 끊어도 서버 프로세스는 살아남고 이후 요청을 정상 처리한다', async () => {
      const namespaceId = await createNamespace('download-client-abort-ns');
      // STORIX_MAX_FILE_SIZE_BYTES(1MiB) 이하에서 스트리밍 도중 끊을 시간을 벌기 위해 큼직하게 채운다.
      const content = Buffer.alloc(900 * 1024, 7);

      await postChunked(
        serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big-download.bin')}`,
        [content],
      );

      await new Promise<void>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: serverPort,
            path: `/api/v2/namespaces/${namespaceId}/fs/content?path=${encodeURIComponent('/big-download.bin')}`,
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
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
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
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(200);

      expect(response.body).toMatchObject({ path: '/b.txt', name: 'b.txt' });
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(404);
    });

    it('목적지가 기존 디렉터리면 그 아래로 배치한다', async () => {
      const namespaceId = await createNamespace('mv-nest-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dest' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/dest' })
        .expect(200);

      expect(response.body.path).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 중간 디렉터리를 생성한다', async () => {
      const namespaceId = await createNamespace('mv-parents-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/x/y/a.txt', destinationParents: true })
        .expect(200);

      expect(response.body.path).toBe('/x/y/a.txt');
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/x' })
        .expect(200);
    });

    it('destinationParents 기본값 false로 중간 디렉터리가 없으면 404를 반환한다', async () => {
      const namespaceId = await createNamespace('mv-no-parents-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/x/a.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });

    it('목적지 경로가 이미 있으면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await createNamespace('mv-conflict-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/b.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });

    it('디렉터리를 자기 subtree 아래로 이동하면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await createNamespace('mv-subtree-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/a', destination: '/a/b' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('source가 root(/)이면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await createNamespace('mv-root-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/', destination: '/x' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('존재하지 않는 source는 404 VFS_NODE_NOT_FOUND를 반환한다', async () => {
      const namespaceId = await createNamespace('mv-missing-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mv`)
        .send({ source: '/missing.txt', destination: '/x.txt' })
        .expect(404);

      expect(response.body.code).toBe('VFS_NODE_NOT_FOUND');
    });
  });

  describe('cp', () => {
    it('file을 복사하면 201과 새 경로를 반환하고 원본은 그대로 남는다', async () => {
      const namespaceId = await createNamespace('cp-file-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(201);

      expect(response.body).toMatchObject({ path: '/b.txt', name: 'b.txt' });
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(200);
    });

    it('복사본이 원본과 같은 content를 서빙하고, 복사본에 write해도 원본 content는 그대로다', async () => {
      const namespaceId = await createNamespace('cp-content-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .set('Content-Type', 'text/plain')
        .send('hello storix')
        .expect(201);

      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(201);

      const copiedContent = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .expect(200);
      expect(copiedContent.text).toBe('hello storix');

      const stat = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/b.txt' })
        .expect(200);

      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .set('If-Match', String(stat.body.version))
        .set('Content-Type', 'text/plain')
        .send('changed')
        .expect(200);

      const originalAfterWrite = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(200);
      expect(originalAfterWrite.text).toBe('hello storix');

      const copiedAfterWrite = await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/b.txt' })
        .expect(200);
      expect(copiedAfterWrite.text).toBe('changed');
    });

    it('목적지가 기존 디렉터리면 그 아래로 배치한다', async () => {
      const namespaceId = await createNamespace('cp-nest-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/dest' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/dest' })
        .expect(201);

      expect(response.body.path).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 중간 디렉터리를 생성한다', async () => {
      const namespaceId = await createNamespace('cp-parents-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/x/y/a.txt', destinationParents: true })
        .expect(201);

      expect(response.body.path).toBe('/x/y/a.txt');
    });

    it('목적지가 이미 있으면 409 VFS_ALREADY_EXISTS를 반환한다', async () => {
      const namespaceId = await createNamespace('cp-conflict-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/b.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a.txt', destination: '/b.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_ALREADY_EXISTS');
    });

    it('디렉터리를 자기 subtree 아래로 복사하면 409 VFS_INVALID_OPERATION을 반환한다', async () => {
      const namespaceId = await createNamespace('cp-subtree-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a/b', parents: true })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/a', destination: '/a/b' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });

    it('디렉터리를 재귀적으로 복사하면 하위 file마다 새 Node를 만들고 원본은 그대로 남는다', async () => {
      const namespaceId = await createNamespace('cp-recursive-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/src/nested', parents: true })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/src/a.txt' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/src/nested/b.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/src', destination: '/dst' })
        .expect(201);

      expect(response.body.path).toBe('/dst');
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/dst/a.txt' })
        .expect(200);
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/dst/nested/b.txt' })
        .expect(200);
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/src/a.txt' })
        .expect(200);
    });

    it('STORIX_MAX_SYNC_COPY_NODES를 넘는 recursive 복사는 시작 전에 413을 반환하고 아무것도 만들지 않는다', async () => {
      const namespaceId = await createNamespace('cp-limit-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/big' })
        .expect(201);
      for (const name of ['1', '2', '3', '4', '5']) {
        await request(httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
          .send({ path: `/big/${name}.txt` })
          .expect(201);
      }
      // big 자신 + file 5개 = 6개 Node > 스위트 상한(5)

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/big', destination: '/copy' })
        .expect(413);

      expect(response.body.code).toBe('VFS_COPY_LIMIT_EXCEEDED');
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/copy' })
        .expect(404);
    });

    it('root는 복사할 수 없다', async () => {
      const namespaceId = await createNamespace('cp-root-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/cp`)
        .send({ source: '/', destination: '/x' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });

  describe('rmdir', () => {
    it('빈 디렉터리를 삭제하면 204를 반환한다', async () => {
      const namespaceId = await createNamespace('rmdir-empty-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a' })
        .expect(204);

      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(404);
    });

    it('비어 있지 않은 디렉터리는 409 VFS_DIRECTORY_NOT_EMPTY를 반환한다', async () => {
      const namespaceId = await createNamespace('rmdir-nonempty-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/x.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a' })
        .expect(409);

      expect(response.body.code).toBe('VFS_DIRECTORY_NOT_EMPTY');
    });

    it('FILE 대상이면 409 VFS_NOT_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('rmdir-file-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/a.txt' })
        .expect(409);

      expect(response.body.code).toBe('VFS_NOT_DIRECTORY');
    });

    it('root는 삭제할 수 없다', async () => {
      const namespaceId = await createNamespace('rmdir-root-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rmdir`)
        .query({ path: '/' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });

  describe('rm', () => {
    it('file을 삭제하면 204를 반환하고 이후 조회에서 사라진다', async () => {
      const namespaceId = await createNamespace('rm-file-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a.txt' })
        .expect(201);

      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a.txt' })
        .expect(204);

      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a.txt' })
        .expect(404);
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.txt' })
        .expect(404);
    });

    it('recursive=false로 directory를 삭제하면 409 VFS_IS_DIRECTORY를 반환한다', async () => {
      const namespaceId = await createNamespace('rm-dir-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a' })
        .expect(409);

      expect(response.body.code).toBe('VFS_IS_DIRECTORY');
    });

    it('recursive=true면 하위 트리를 모두 삭제한다', async () => {
      const namespaceId = await createNamespace('rm-recursive-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/a' })
        .expect(201);
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
        .send({ path: '/a/x.txt' })
        .expect(201);

      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/a', recursive: 'true' })
        .expect(204);

      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/a' })
        .expect(404);
    });

    it('STORIX_MAX_SYNC_DELETE_NODES를 넘는 recursive 삭제는 시작 전에 413을 반환하고 아무것도 지우지 않는다', async () => {
      const namespaceId = await createNamespace('rm-limit-ns');
      await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mkdir`)
        .send({ path: '/big' })
        .expect(201);
      for (const name of ['1', '2', '3', '4', '5']) {
        await request(httpServer)
          .post(`/api/v2/namespaces/${namespaceId}/fs/touch`)
          .send({ path: `/big/${name}.txt` })
          .expect(201);
      }
      // big 자신 + file 5개 = 6개 Node > 스위트 상한(5)

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/big', recursive: 'true' })
        .expect(413);

      expect(response.body.code).toBe('VFS_DELETE_LIMIT_EXCEEDED');
      await request(httpServer)
        .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
        .query({ path: '/big/1.txt' })
        .expect(200);
    });

    it('root는 삭제할 수 없다', async () => {
      const namespaceId = await createNamespace('rm-root-ns');

      const response = await request(httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/rm`)
        .query({ path: '/', recursive: 'true' })
        .expect(409);

      expect(response.body.code).toBe('VFS_INVALID_OPERATION');
    });
  });
});
