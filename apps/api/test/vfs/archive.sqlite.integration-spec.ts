// SQLite migration, 실제 VFS repository, HTTP route와 메모리 BlobStorage로 archive 생성·receipt 재생을 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MASTER_KEY } from '../../src/encryption/encryption.constants.js';
import { jest } from '@jest/globals';
import { AuthModule } from '../../src/auth/auth.module.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { DataSource, IsNull } from 'typeorm';
import request from 'supertest';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { ArchiveSourceRepository } from '../../src/persistence/archive-source.repository.js';
import { VfsArchiveDeadlineExceededError } from '../../src/vfs/vfs.errors.js';
import { GcJobModule } from '../../src/jobs/gc-job.module.js';
import { GcJob } from '../../src/jobs/gc.job.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { ARCHIVE_CONFIG } from '../../src/vfs/archive-config.js';
import type { ArchiveConfig } from '../../src/vfs/archive-config.js';

const API_KEY = 'archive-sqlite-integration-key';

describe('archive HTTP (SQLite)', () => {
  let directory: string;
  let app: INestApplication;
  let dataSource: DataSource;
  let namespaceId: string;
  let sourceBytes: Buffer;
  const objects = new Map<string, Buffer>();
  let getCount = 0;
  let failNextGet = false;
  let stallNextGet = false;
  let stalledGet: Readable | undefined;
  let resolveGetStall: (() => void) | undefined;
  let beforeGet: (() => Promise<void>) | undefined;
  const previous = { ...process.env };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'storix-archive-'));
    Object.assign(process.env, {
      STORIX_DB_DRIVER: 'sqlite',
      STORIX_DB_SQLITE_PATH: join(directory, 'archive.sqlite'),
      STORIX_API_KEY: API_KEY,
      STORIX_ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      STORIX_STORAGE_ENDPOINT: '127.0.0.1',
      STORIX_STORAGE_PORT: '9000',
      STORIX_STORAGE_ACCESS_KEY: 'test-access',
      STORIX_STORAGE_SECRET_KEY: 'test-secret',
      STORIX_STORAGE_BUCKET: 'archive-test',
      STORIX_ARCHIVE_MAX_SECONDS: '60',
      STORIX_ORPHAN_GRACE_PERIOD: '86400',
      STORIX_MUTATION_LEASE_SECONDS: '2',
    });
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: join(directory, 'archive.sqlite'),
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.destroy();
    const storage = {
      async get(key: string, _range?: unknown, signal?: AbortSignal) {
        getCount += 1;
        if (failNextGet) {
          failNextGet = false;
          objects.delete(key);
          throw new Error('source disappeared after capture');
        }
        if (stallNextGet) {
          stallNextGet = false;
          const stalled = new Readable({ read: () => undefined });
          stalled.on('error', () => undefined);
          stalledGet = stalled;
          resolveGetStall?.();
          resolveGetStall = undefined;
          const abort = () =>
            stalled.destroy(signal?.reason instanceof Error ? signal.reason : new Error('GET aborted'));
          const cleanup = () => signal?.removeEventListener('abort', abort);
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
          stalled.once('close', cleanup);
          return stalled;
        }
        const hook = beforeGet;
        beforeGet = undefined;
        await hook?.();
        const data = objects.get(key);
        if (!data) throw new Error('missing source object');
        return Readable.from([data]);
      },
      async put(key: string, stream: NodeJS.ReadableStream) {
        const chunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks));
      },
      async delete(key: string) {
        objects.delete(key);
      },
      async *list() {},
      async listPage() {
        return { items: [], nextAfter: null };
      },
      async listIncompleteUploadsPage() {
        return { items: [], next: null };
      },
      async abortIncompleteUpload() {},
      async getPresignedUrl() {
        return 'unused';
      },
    } as unknown as BlobStorage;
    const capabilities = new CapabilityService({
      globalAllowedCapabilities: ['archive'],
      defaultEnabledCapabilities: ['archive'],
      namespaceAllowedCapabilities: {},
    });
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        AuthModule,
        NamespaceModule,
        VfsModule,
        GcJobModule,
      ],
    })
      .overrideProvider(MASTER_KEY)
      .useValue(Buffer.from('ab'.repeat(32), 'hex'))
      .overrideProvider(BLOB_STORAGE)
      .useValue(storage)
      .overrideProvider(CapabilityService)
      .useValue(capabilities)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();
    await app.listen(0);
    namespaceId = (
      await request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('Idempotency-Key', randomUUID())
        .send({ name: randomUUID() })
        .expect(201)
    ).body.id as string;
    const db = app.get(DataSource);
    const root = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, parentId: IsNull() });
    sourceBytes = Buffer.from('archive source payload');
    const storageKey = `blobs/${randomUUID()}`;
    objects.set(storageKey, sourceBytes);
    const digest = createHash('sha256').update(sourceBytes).digest('hex');
    const blob = await db.getRepository(BlobEntity).save(
      db.getRepository(BlobEntity).create({
        namespaceId,
        storageKey,
        size: String(sourceBytes.length),
        mimeType: 'text/plain',
        sha256: digest,
        referenceCount: 1,
      }),
    );
    await db.getRepository(VfsNodeEntity).save(
      db.getRepository(VfsNodeEntity).create({
        namespaceId,
        parentId: root.id,
        type: 'FILE',
        name: 'source.txt',
        blobId: blob.id,
        size: String(sourceBytes.length),
        mimeType: 'text/plain',
      }),
    );
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  it('HTTP archive 요청은 ZIP FILE을 만들고 동일 key 재시도에서 receipt를 재생한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const key = randomUUID();
    const body = { target: '/result.zip', entries: [{ id: source.id, name: 'source.txt' }] };
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const first = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .set('X-Expires-In', '3600')
      .send(body)
      .expect(201);
    expect(first.body.entryCount).toBe(1);
    expect(first.body.resource.mimeType).toBe('application/zip');
    expect(first.body.resource.expiresAt).toEqual(expect.any(String));
    const resultNode = await db.getRepository(VfsNodeEntity).findOneByOrFail({ id: first.body.resource.id });
    const resultBlob = await db.getRepository(BlobEntity).findOneByOrFail({ id: resultNode.blobId! });
    const zipObject = objects.get(resultBlob.storageKey);
    expect(zipObject?.subarray(0, 4).toString('hex')).toBe('504b0304');
    const downloadedZip = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path: '/result.zip' })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    execFileSync(
      'python3',
      [
        '-c',
        "import io,sys,zipfile; assert zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('source.txt') == b'archive source payload'",
      ],
      { input: downloadedZip.body as Buffer },
    );
    expect(downloadedZip.body).toEqual(zipObject);
    const reads = getCount;
    const replay = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .set('X-Expires-In', '3600')
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(getCount).toBe(reads);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .set('X-Expires-In', '3600')
      .send({ ...body, target: '/different-result.zip' })
      .expect(409)
      .expect(({ body: response }) => expect(response.code).toBe('MUTATION_KEY_REUSED'));
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/mutations`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send({ kind: 'mkdir', path: '/other', ifAbsent: true })
      .expect(409)
      .expect(({ body: response }) => expect(response.code).toBe('MUTATION_KEY_REUSED'));
    expect(getCount).toBe(reads);
  });

  it('capture 뒤 원본이 사라진 요청은 완료 receipt를 남기지 않고 같은 key 재시도를 허용한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const key = randomUUID();
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const body = { target: '/source-loss.zip', entries: [{ id: source.id, name: 'source.txt' }] };
    failNextGet = true;

    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(500);
    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'source-loss.zip' }),
    ).resolves.toBeNull();
    const sourceBlob = await db.getRepository(BlobEntity).findOneByOrFail({ id: source.blobId! });
    objects.set(sourceBlob.storageKey, sourceBytes);

    const retry = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(retry.body.entryCount).toBe(1);
  });

  it('afterBump deadline 실패는 FILE과 root revision을 롤백한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const rootBefore = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    const archiveSources = app.get(ArchiveSourceRepository);
    const deadlineSpy = jest.spyOn(archiveSources, 'assertDeadline');
    let checks = 0;
    deadlineSpy.mockImplementation(async () => {
      checks += 1;
      if (checks === 2) throw new VfsArchiveDeadlineExceededError();
    });
    try {
      await request(app.getHttpServer())
        .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', randomUUID())
        .send({ target: '/late.zip', entries: [{ id: source.id, name: 'source.txt' }] })
        .expect(503);
    } finally {
      deadlineSpy.mockRestore();
    }
    const rootAfter = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    expect(rootAfter.version).toBe(rootBefore.version);
    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'late.zip' }),
    ).resolves.toBeNull();
  });

  it('capture 뒤 target 부모가 삭제되면 FILE을 만들지 않고 미참조 ZIP object를 정리한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const root = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    const parent = await db.getRepository(VfsNodeEntity).save(
      db.getRepository(VfsNodeEntity).create({
        namespaceId,
        parentId: root.id,
        type: 'DIRECTORY',
        name: 'vanishing',
        blobId: null,
        size: null,
        mimeType: null,
      }),
    );
    beforeGet = async () => {
      await db.getRepository(VfsNodeEntity).delete({ id: parent.id, namespaceId });
    };
    const objectKeysBefore = [...objects.keys()].sort();
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', randomUUID())
      .send({ target: '/vanishing/result.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(404);

    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, parentId: parent.id, name: 'result.zip' }),
    ).resolves.toBeNull();
    expect([...objects.keys()].sort()).toEqual(objectKeysBefore);
  });

  it('source checksum 불일치는 FILE과 완료 receipt를 남기지 않는다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const sourceBlob = await db.getRepository(BlobEntity).findOneByOrFail({ id: source.blobId! });
    objects.set(sourceBlob.storageKey, Buffer.from('tampered source'));
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const key = randomUUID();
    const body = { target: '/checksum.zip', entries: [{ id: source.id, name: 'source.txt' }] };
    try {
      await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(500);
      await expect(
        db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'checksum.zip' }),
      ).resolves.toBeNull();
    } finally {
      objects.set(sourceBlob.storageKey, sourceBytes);
    }
    const retry = await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(retry.body.entryCount).toBe(1);
  });

  it('capture 뒤 원본을 고아로 바꾸고 GC가 object를 회수하면 실패하고 claim을 해제한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const sourceBlob = await db.getRepository(BlobEntity).findOneByOrFail({ id: source.blobId! });
    const root = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    const gc = app.get(GcJob);
    // archive 부팅 불변식은 유지하면서 이 테스트의 GC 회수 경계만 1초로 줄인다.
    Object.defineProperty(gc, 'gracePeriodSeconds', { value: 1 });
    beforeGet = async () => {
      await db.getRepository(VfsNodeEntity).delete({ id: source.id, namespaceId });
      await db
        .getRepository(BlobEntity)
        .update({ id: sourceBlob.id }, { referenceCount: 0, zeroSince: new Date(Date.now() - 2000) });
      const result = await gc.run();
      expect(result.deletedOrphanBlobs).toBe(1);
    };
    const key = randomUUID();
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const body = { target: '/gc-source-loss.zip', entries: [{ id: source.id, name: 'source.txt' }] };
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(500);
    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'gc-source-loss.zip' }),
    ).resolves.toBeNull();
    await expect(db.getRepository(BlobEntity).findOneBy({ id: sourceBlob.id })).resolves.toBeNull();
    expect(objects.has(sourceBlob.storageKey)).toBe(false);

    await db.getRepository(BlobEntity).save({ ...sourceBlob, referenceCount: 1, zeroSince: null });
    await db.getRepository(VfsNodeEntity).save(source);
    await db.getRepository(VfsNodeEntity).increment({ id: root.id }, 'childFileCount', 1);
    objects.set(sourceBlob.storageKey, sourceBytes);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
  });

  it('receipt owner child process가 강제 종료되면 lease 만료 뒤 takeover하고 이전 generation을 차단한다', async () => {
    const key = randomUUID();
    const scope = 'archive-process-kill';
    const apiDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
    const childCode = `
      import { DataSource } from 'typeorm';
      import { NamespaceEntity } from ${JSON.stringify(pathToFileURL(resolve(apiDist, 'persistence/entities/namespace.entity.js')).href)};
      import { VfsMutationReceiptEntity } from ${JSON.stringify(pathToFileURL(resolve(apiDist, 'persistence/entities/vfs-mutation-receipt.entity.js')).href)};
      import { VfsMutationReceiptRepository } from ${JSON.stringify(pathToFileURL(resolve(apiDist, 'persistence/vfs-mutation-receipt.repository.js')).href)};
      const dataSource = new DataSource({ type: 'better-sqlite3', database: process.env.STORIX_DB_SQLITE_PATH, entities: [NamespaceEntity, VfsMutationReceiptEntity], synchronize: false });
      await dataSource.initialize();
      const repository = new VfsMutationReceiptRepository(dataSource);
      const result = await repository.claim({ namespaceId: process.env.ARCHIVE_TEST_NAMESPACE, scope: process.env.ARCHIVE_TEST_SCOPE, key: process.env.ARCHIVE_TEST_KEY }, new Date());
      console.log('CLAIMED:' + result.kind + ':' + (result.kind === 'owner' ? result.generation : 'none'));
      setInterval(() => undefined, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ARCHIVE_TEST_NAMESPACE: namespaceId,
        ARCHIVE_TEST_SCOPE: scope,
        ARCHIVE_TEST_KEY: key,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    let readyTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolveReady, rejectReady) => {
          const poll = setInterval(() => {
            if (stdout.includes('CLAIMED:owner:1')) {
              clearInterval(poll);
              resolveReady();
            } else if (child.exitCode !== null) {
              clearInterval(poll);
              rejectReady(new Error(`receipt child exited early: ${stderr}`));
            }
          }, 10);
        }),
        new Promise<never>((_, reject) => {
          readyTimer = setTimeout(() => reject(new Error(`receipt child timeout: ${stderr}`)), 5000);
        }),
      ]);
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }
    child.kill('SIGKILL');
    const [exitCode, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(exitCode).toBeNull();
    expect(signal).toBe('SIGKILL');

    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const body = {
      target: '/process-recovery.zip',
      entries: [
        {
          id: (
            await app.get(DataSource).getRepository(VfsNodeEntity).findOneByOrFail({
              namespaceId,
              name: 'source.txt',
            })
          ).id,
          name: 'source.txt',
        },
      ],
    };
    const send = () =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', scope)
        .set('Idempotency-Key', key)
        .send(body);
    await send()
      .expect(409)
      .expect(({ body: response }) => expect(response.code).toBe('MUTATION_IN_PROGRESS'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
    await send().expect(201);
    const identity = { namespaceId, scope, key };
    await expect(
      app.get(VfsMutationReceiptRepository).completeAfterRollback(identity, 1, 'old', 'POST', {
        status: 201,
        body: {},
        headers: {},
      }),
    ).rejects.toThrow('VFS mutation claim lost');
  }, 15000);

  it.each(['GET', 'PUT'] as const)(
    'archive %s 중 process SIGKILL 뒤 lease takeover로 재시도한다',
    async (stage) => {
      const source = await app
        .get(DataSource)
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, name: 'source.txt' });
      const key = randomUUID();
      const scope = `archive-kill-${stage.toLowerCase()}`;
      const target = `/process-kill-${stage.toLowerCase()}.zip`;
      const body = JSON.stringify({ target, entries: [{ id: source.id, name: 'source.txt' }] });
      const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
      const uri = (path: string) => JSON.stringify(pathToFileURL(resolve(dist, path)).href);
      const childCode = `
      import { Test } from '@nestjs/testing';
      import { ConfigModule } from '@nestjs/config';
      import { Readable } from 'node:stream';
      import { request } from 'node:http';
      import { AuthModule } from ${uri('auth/auth.module.js')};
      import { NamespaceModule } from ${uri('namespace/namespace.module.js')};
      import { VfsModule } from ${uri('vfs/vfs.module.js')};
      import { MASTER_KEY } from ${uri('encryption/encryption.constants.js')};
      import { BLOB_STORAGE } from ${uri('storage/storage.constants.js')};
      import { CapabilityService } from ${uri('capability/capability.service.js')};
      import { configureBodyParsers } from ${uri('common/body-parser.js')};
      const storage = {
        async get() {
          if (process.env.ARCHIVE_KILL_STAGE === 'GET') {
            console.log('ARCHIVE_GET_STALLED');
            return new Readable({ read() {} });
          }
          return Readable.from([Buffer.from('archive source payload')]);
        },
        async put(_key, stream) {
          if (process.env.ARCHIVE_KILL_STAGE === 'PUT') {
            for await (const _chunk of stream) {
              console.log('ARCHIVE_PUT_STALLED');
              await new Promise(() => {});
            }
          }
        },
        async delete() {}, async *list() {}, async listPage() { return { items: [], nextAfter: null }; },
        async listIncompleteUploadsPage() { return { items: [], next: null }; },
        async abortIncompleteUpload() {}, async getPresignedUrl() { return 'unused'; },
      };
      const capability = new CapabilityService({ globalAllowedCapabilities: ['archive'], defaultEnabledCapabilities: ['archive'], namespaceAllowedCapabilities: {} });
      const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule, VfsModule] })
        .overrideProvider(MASTER_KEY).useValue(Buffer.from('ab'.repeat(32), 'hex'))
        .overrideProvider(BLOB_STORAGE).useValue(storage)
        .overrideProvider(CapabilityService).useValue(capability)
        .compile();
      const app = module.createNestApplication({ bodyParser: false });
      configureBodyParsers(app);
      await app.init();
      await app.listen(0);
      const port = app.getHttpServer().address().port;
      console.log('ARCHIVE_READY:' + port);
      const req = request({ host: '127.0.0.1', port, path: '/api/v2/namespaces/' + process.env.ARCHIVE_TEST_NAMESPACE + '/fs/archive', method: 'POST', headers: {
        authorization: 'Bearer ' + process.env.STORIX_API_KEY,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(process.env.ARCHIVE_TEST_BODY),
        'x-mutation-scope': process.env.ARCHIVE_TEST_SCOPE, 'idempotency-key': process.env.ARCHIVE_TEST_KEY,
      } }, (res) => res.resume());
      req.on('error', () => {});
      req.end(process.env.ARCHIVE_TEST_BODY);
    `;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ARCHIVE_TEST_NAMESPACE: namespaceId,
          ARCHIVE_TEST_SCOPE: scope,
          ARCHIVE_TEST_KEY: key,
          ARCHIVE_TEST_BODY: body,
          ARCHIVE_KILL_STAGE: stage,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const childExit = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const marker = stage === 'GET' ? 'ARCHIVE_GET_STALLED' : 'ARCHIVE_PUT_STALLED';
      const readyDeadline = Date.now() + 10000;
      while (!stdout.includes(marker) && child.exitCode === null && Date.now() < readyDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      if (!stdout.includes(marker)) {
        child.kill('SIGKILL');
        await childExit;
        throw new Error(`archive child did not reach ${stage} stall: ${stderr}`);
      }
      child.kill('SIGKILL');
      const [exitCode, signal] = await childExit;
      expect(exitCode).toBeNull();
      expect(signal).toBe('SIGKILL');

      const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
      const send = () =>
        request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${API_KEY}`)
          .set('X-Mutation-Scope', scope)
          .set('Idempotency-Key', key)
          .send(JSON.parse(body) as { target: string; entries: Array<{ id: string; name: string }> });
      await send()
        .expect(409)
        .expect(({ body: response }) => expect(response.code).toBe('MUTATION_IN_PROGRESS'));
      await expect(
        app
          .get(DataSource)
          .getRepository(VfsNodeEntity)
          .findOneBy({ namespaceId, name: target.slice(1) }),
      ).resolves.toBeNull();
      await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
      await send().expect(201);
    },
    30000,
  );

  it('DB commit 뒤 HTTP 응답을 잃어도 같은 key 재시도에서 완료 receipt를 재생한다', async () => {
    const source = await app
      .get(DataSource)
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId, name: 'source.txt' });
    const key = randomUUID();
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const body = JSON.stringify({
      target: '/ack-lost.zip',
      entries: [{ id: source.id, name: 'source.txt' }],
    });
    const readsBefore = getCount;
    const port = (app.getHttpServer().address() as AddressInfo).port;
    await new Promise<void>((resolveResponse) => {
      const client = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            authorization: `Bearer ${API_KEY}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-mutation-scope': 'archive-ack-loss',
            'idempotency-key': key,
          },
        },
        (response) => {
          response.on('error', () => undefined);
          response.destroy();
          resolveResponse();
        },
      );
      client.on('error', () => undefined);
      client.end(body);
    });
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-ack-loss')
      .set('Idempotency-Key', key)
      .send(JSON.parse(body) as { target: string; entries: Array<{ id: string; name: string }> })
      .expect(201);
    expect(getCount).toBe(readsBefore + 1);
    await expect(
      app.get(DataSource).getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'ack-lost.zip' }),
    ).resolves.not.toBeNull();
  });

  it('암호화 namespace에서 source 다운로드와 archive 다운로드가 평문을 보존한다', async () => {
    const encryptedNamespace = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name: randomUUID(), encryptionPolicy: 'ENCRYPTED' })
      .expect(201);
    const ns = encryptedNamespace.body.id as string;
    const payload = Buffer.from('encrypted namespace payload');
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${ns}/fs/content`)
      .query({ path: '/secret.txt' })
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Content-Type', 'text/plain')
      .send(payload)
      .expect(201);
    const source = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${ns}/fs/download`)
      .query({ path: '/secret.txt' })
      .set('Authorization', `Bearer ${API_KEY}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(source.body).toEqual(payload);
    const sourceNode = await app
      .get(DataSource)
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: ns, name: 'secret.txt' });

    const archive = await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${ns}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-encrypted')
      .set('Idempotency-Key', randomUUID())
      .send({ target: '/result.zip', entries: [{ id: sourceNode.id, name: 'secret.txt' }] })
      .expect(201);
    const downloadedZip = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${ns}/fs/download`)
      .query({ path: '/result.zip' })
      .set('Authorization', `Bearer ${API_KEY}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const zipBytes = downloadedZip.body as Buffer;
    expect(zipBytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    execFileSync(
      'python3',
      [
        '-c',
        "import io,sys,zipfile; assert zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('secret.txt') == b'encrypted namespace payload'",
      ],
      { input: zipBytes },
    );
    const result = await app
      .get(DataSource)
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ id: archive.body.resource.id as string });
    const resultBlob = await app
      .get(DataSource)
      .getRepository(BlobEntity)
      .findOneByOrFail({ id: result.blobId! });
    expect(objects.get(resultBlob.storageKey)).not.toEqual(zipBytes);
  });

  it('capture 뒤 quota가 줄면 commit을 거부하고 미참조 ZIP object를 정리한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const rootBefore = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    const objectsBefore = [...objects.keys()].sort();
    beforeGet = async () => {
      await db.getRepository(NamespaceEntity).update({ id: namespaceId }, { maxTotalLogicalBytes: '1' });
    };
    try {
      await request(app.getHttpServer())
        .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', randomUUID())
        .send({ target: '/quota-race.zip', entries: [{ id: source.id, name: 'source.txt' }] })
        .expect(413);
    } finally {
      await db.getRepository(NamespaceEntity).update({ id: namespaceId }, { maxTotalLogicalBytes: null });
    }
    const rootAfter = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    expect(rootAfter.version).toBe(rootBefore.version);
    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'quota-race.zip' }),
    ).resolves.toBeNull();
    expect([...objects.keys()].sort()).toEqual(objectsBefore);
  });

  it('capture 뒤 다른 요청이 target을 만들면 조건부 commit을 거부하고 경쟁 FILE을 보존한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const path = `/api/v2/namespaces/${namespaceId}/fs`;
    const competingBytes = Buffer.from('concurrent target');
    beforeGet = async () => {
      await request(app.getHttpServer())
        .post(`${path}/content`)
        .query({ path: '/raced.zip' })
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('Content-Type', 'text/plain')
        .send(competingBytes)
        .expect(201);
    };
    const objectCountBefore = objects.size;
    await request(app.getHttpServer())
      .post(`${path}/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', randomUUID())
      .send({ target: '/raced.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(412);

    const target = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'raced.zip' });
    const content = await request(app.getHttpServer())
      .get(`${path}/content`)
      .query({ path: '/raced.zip' })
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(content.text).toBe(competingBytes.toString());
    expect(objects.size).toBe(objectCountBefore + 1);
    expect(target.blobId).not.toBeNull();
  });

  it('sink 응답이 멈추면 archive deadline이 PUT를 취소하고 같은 key 재시도를 허용한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const rootBefore = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const originalPut = storage.put.bind(storage);
    const archiveConfig = app.get<ArchiveConfig>(ARCHIVE_CONFIG);
    const originalMaxSeconds = archiveConfig.maxSeconds;
    const mutableArchiveConfig = archiveConfig as { maxSeconds: number };
    const key = randomUUID();
    let putSettled = false;
    const attemptedKeys: string[] = [];
    storage.put = async (storageKey, stream, _contentType, signal) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      objects.set(storageKey, Buffer.concat(chunks));
      attemptedKeys.push(storageKey);
      try {
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(signal?.reason ?? new Error('PUT aborted'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        putSettled = true;
      }
    };
    mutableArchiveConfig.maxSeconds = 1;
    try {
      await request(app.getHttpServer())
        .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', key)
        .send({ target: '/sink-stall.zip', entries: [{ id: source.id, name: 'source.txt' }] })
        .expect(503)
        .expect(({ body: response }) => expect(response.code).toBe('VFS_ARCHIVE_TIMEOUT'));
      expect(putSettled).toBe(true);
      expect(attemptedKeys).toHaveLength(1);
      expect(objects.has(attemptedKeys[0]!)).toBe(true);
      await expect(
        db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'sink-stall.zip' }),
      ).resolves.toBeNull();
      const rootAfter = await db.getRepository(VfsNodeEntity).findOneByOrFail({
        namespaceId,
        parentId: IsNull(),
      });
      expect(rootAfter.version).toBe(rootBefore.version);
    } finally {
      storage.put = originalPut;
      mutableArchiveConfig.maxSeconds = originalMaxSeconds;
    }
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send({ target: '/sink-stall.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(201);
  });

  it('ZIP 결과 상한을 넘으면 FILE과 미참조 object를 정리하고 오류 receipt를 재생한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const rootBefore = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    const archiveConfig = app.get<ArchiveConfig>(ARCHIVE_CONFIG);
    const mutableArchiveConfig = archiveConfig as { maxResultBytes: bigint };
    const originalLimit = archiveConfig.maxResultBytes;
    const objectsBefore = [...objects.keys()].sort();
    const readsBefore = getCount;
    const key = randomUUID();
    mutableArchiveConfig.maxResultBytes = 16n;
    try {
      await request(app.getHttpServer())
        .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', key)
        .send({ target: '/result-cap.zip', entries: [{ id: source.id, name: 'source.txt' }] })
        .expect(413)
        .expect(({ body: response }) => expect(response.code).toBe('VFS_ARCHIVE_TOO_LARGE'));
    } finally {
      mutableArchiveConfig.maxResultBytes = originalLimit;
    }
    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'result-cap.zip' }),
    ).resolves.toBeNull();
    const rootAfter = await db.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId,
      parentId: IsNull(),
    });
    expect(rootAfter.version).toBe(rootBefore.version);
    expect([...objects.keys()].sort()).toEqual(objectsBefore);
    const readsAfterFailure = getCount;
    expect(readsAfterFailure).toBe(readsBefore);
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send({ target: '/result-cap.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(413);
    expect(getCount).toBe(readsAfterFailure);
  });

  it('receipt lease 갱신 실패는 FILE commit을 막고 같은 key 재시도를 허용한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const receipts = app.get(VfsMutationReceiptRepository);
    const originalRenew = receipts.renew.bind(receipts);
    const key = randomUUID();
    receipts.renew = async () => false;
    try {
      await request(app.getHttpServer())
        .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', key)
        .send({ target: '/lease-lost.zip', entries: [{ id: source.id, name: 'source.txt' }] })
        .expect(500);
      await expect(
        db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'lease-lost.zip' }),
      ).resolves.toBeNull();
    } finally {
      receipts.renew = originalRenew;
    }
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send({ target: '/lease-lost.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(201);
  });

  it('source GET 본문 stall은 deadline에 취소되고 FILE 없이 같은 key 재시도를 허용한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const archiveConfig = app.get<ArchiveConfig>(ARCHIVE_CONFIG);
    const mutableArchiveConfig = archiveConfig as { maxSeconds: number };
    const originalMaxSeconds = archiveConfig.maxSeconds;
    const key = randomUUID();
    mutableArchiveConfig.maxSeconds = 1;
    stallNextGet = true;
    try {
      await request(app.getHttpServer())
        .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', key)
        .send({ target: '/get-stall.zip', entries: [{ id: source.id, name: 'source.txt' }] })
        .expect(503)
        .expect(({ body: response }) => expect(response.code).toBe('VFS_ARCHIVE_TIMEOUT'));
      await expect(
        db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'get-stall.zip' }),
      ).resolves.toBeNull();
    } finally {
      mutableArchiveConfig.maxSeconds = originalMaxSeconds;
    }
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send({ target: '/get-stall.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(201);
  });

  it('동시 실행 gate가 찬 요청은 HTTP 503과 Retry-After를 반환한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const originalMaxSeconds = app.get<ArchiveConfig>(ARCHIVE_CONFIG).maxSeconds;
    const config = app.get<ArchiveConfig>(ARCHIVE_CONFIG) as { maxSeconds: number };
    const key = randomUUID();
    config.maxSeconds = 60;
    stallNextGet = true;
    stalledGet = undefined;
    const active = request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send({ target: '/busy-owner.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .then((response) => response);
    try {
      for (let attempt = 0; attempt < 100 && stalledGet === undefined; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stalledGet).toBeDefined();
      const busy = await request(app.getHttpServer())
        .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'archive-test')
        .set('Idempotency-Key', randomUUID())
        .send({ target: '/busy-rejected.zip', entries: [{ id: source.id, name: 'source.txt' }] })
        .expect(503);
      expect(busy.body.code).toBe('VFS_ARCHIVE_BUSY');
      expect(busy.headers['retry-after']).toBe('10');
    } finally {
      config.maxSeconds = originalMaxSeconds;
      (stalledGet as Readable | undefined)?.destroy(new Error('release stalled archive GET'));
    }
    expect((await active).status).toBe(500);
    await request(app.getHttpServer())
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send({ target: '/busy-owner.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(201);
    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'busy-rejected.zip' }),
    ).resolves.toBeNull();
  });

  it('응답을 받기 전에 HTTP client가 끊기면 source를 닫고 claim을 해제한다', async () => {
    const db = app.get(DataSource);
    const source = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, name: 'source.txt' });
    const key = randomUUID();
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const body = JSON.stringify({
      target: '/client-close.zip',
      entries: [{ id: source.id, name: 'source.txt' }],
    });
    const entered = new Promise<void>((resolve) => (resolveGetStall = resolve));
    stallNextGet = true;
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-mutation-scope': 'archive-test',
        'idempotency-key': key,
      },
    });
    client.on('response', (response) => response.resume());
    client.on('error', () => undefined);
    client.end(body);
    await entered;
    const activeSource = stalledGet!;
    client.destroy();
    if (!activeSource.closed)
      await new Promise<void>((resolveClose) => activeSource.once('close', resolveClose));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await expect(
      db.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'client-close.zip' }),
    ).resolves.toBeNull();
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'archive-test')
      .set('Idempotency-Key', key)
      .send(JSON.parse(body) as { target: string; entries: Array<{ id: string; name: string }> })
      .expect(201);
  });
});
