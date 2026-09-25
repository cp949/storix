import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { Client as MinioClient } from 'minio';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureBodyParsers } from '../common/body-parser.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import { NamespaceModule } from '../namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { MinioBlobStorage } from '../storage/minio-blob-storage.js';
import { VfsModule } from './vfs.module.js';
import { encodeRevision } from './revision.js';
import { snapshotPost, treeSnapshotContract } from './vfs-snapshot-tree.test-support.js';

describe('SQLite file + MinIO snapshot HTTP durability', () => {
  let container: StartedMinioContainer | undefined;
  let directory: string | undefined;
  let app: INestApplication;
  const previous = { ...process.env };

  async function bootstrap() {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule, VfsModule],
    })
      .overrideProvider(MASTER_KEY)
      .useValue(Buffer.from('ab'.repeat(32), 'hex'))
      .compile();
    const next = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(next);
    await next.init();
    await next.listen(0);
    expect(next.get(BLOB_STORAGE)).toBeInstanceOf(MinioBlobStorage);
    return next;
  }

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('Run with STORIX_DB_DRIVER=sqlite');
    directory = await mkdtemp(join(tmpdir(), 'storix-snapshot-http-'));
    process.env.STORIX_DB_SQLITE_PATH = join(directory, 'snapshot.sqlite');
    container = await new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start();
    Object.assign(process.env, {
      STORIX_STORAGE_ENDPOINT: container.getHost(),
      STORIX_STORAGE_PORT: String(container.getPort()),
      STORIX_STORAGE_USE_SSL: 'false',
      STORIX_STORAGE_ACCESS_KEY: container.getUsername(),
      STORIX_STORAGE_SECRET_KEY: container.getPassword(),
      STORIX_STORAGE_BUCKET: 'snapshot-sqlite',
    });
    const client = new MinioClient({
      endPoint: container.getHost(),
      port: container.getPort(),
      useSSL: false,
      accessKey: container.getUsername(),
      secretKey: container.getPassword(),
    });
    await client.makeBucket('snapshot-sqlite');
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
    app = await bootstrap();
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

  treeSnapshotContract(() => app);

  it('앱과 DB 연결을 재생성해도 metadata/pages/bytes/restore 및 세 mutation receipt가 보존된다', async () => {
    const http = () => request(app.getHttpServer());
    const ns = await http()
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'restart-encrypted', encryptionPolicy: 'ENCRYPTED' })
      .expect(201);
    const base = `/api/v1/namespaces/${ns.body.id}/fs`;
    await http().post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
    const bytes = Buffer.from([0, 255, 128, 65]);
    await http()
      .post(`${base}/content`)
      .query({ path: '/dir/a' })
      .set('Content-Type', 'application/octet-stream')
      .send(bytes)
      .expect(201);
    await http()
      .post(`${base}/content`)
      .query({ path: '/dir/b' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('second'))
      .expect(201);
    const treeKey = randomUUID();
    const treeBody = { kind: 'tree', path: '/dir' };
    const tree = await snapshotPost(app, base, '', treeBody, treeKey).expect(201);
    const treeId = tree.body.snapshotId;
    const firstPage = (
      await http().get(`${base}/snapshots/${treeId}/entries`).query({ limit: 2 }).expect(200)
    ).body;
    const secondPage = (
      await http()
        .get(`${base}/snapshots/${treeId}/entries`)
        .query({ limit: 2, cursor: firstPage.nextCursor })
        .expect(200)
    ).body;
    const fileKey = randomUUID();
    const fileBody = { kind: 'file', path: '/dir/a' };
    const file = await snapshotPost(app, base, '', fileBody, fileKey).expect(201);
    const fileId = file.body.snapshotId;
    const restoreKey = randomUUID();
    const restoreBody = { path: '/restored', ifAbsent: true };
    const restored = await snapshotPost(app, base, `/${fileId}/restore`, restoreBody, restoreKey).expect(201);
    const deletedSnapshot = await snapshotPost(app, base, '', { kind: 'file', path: '/dir/b' }).expect(201);
    const deleteKey = randomUUID();
    const deleteSuffix = `/${deletedSnapshot.body.snapshotId}/delete`;
    const deleted = await snapshotPost(app, base, deleteSuffix, {}, deleteKey).expect(200);
    // SQLite가 지원하는 한 프로세스의 순차 writer로 원본을 제거한다.
    await http().post(`${base}/rm`).query({ path: '/dir', recursive: true }).expect(204);
    const oldDataSource = app.get(DataSource);
    await app.close();
    expect(oldDataSource.isInitialized).toBe(false);
    app = await bootstrap();
    expect(app.get(DataSource)).not.toBe(oldDataSource);
    expect((await http().get(`${base}/snapshots/${treeId}`).expect(200)).body).toEqual(tree.body);
    expect((await http().get(`${base}/snapshots/${fileId}`).expect(200)).body).toEqual(file.body);
    expect(
      (await http().get(`${base}/snapshots/${treeId}/entries`).query({ limit: 2 }).expect(200)).body,
    ).toEqual(firstPage);
    expect(
      (
        await http()
          .get(`${base}/snapshots/${treeId}/entries`)
          .query({ limit: 2, cursor: firstPage.nextCursor })
          .expect(200)
      ).body,
    ).toEqual(secondPage);
    for (const path of [
      `${base}/snapshots/${fileId}/content`,
      `${base}/snapshots/${treeId}/content?path=a`,
      `${base}/content?path=/restored`,
    ])
      expect((await http().get(path).expect(200)).body).toEqual(bytes);
    expect(
      (
        await http()
          .get(`${base}/snapshots/${treeId}/content`)
          .query({ path: 'a' })
          .set('Range', 'bytes=1-2')
          .expect(206)
      ).body,
    ).toEqual(Buffer.from([255, 128]));
    for (const [suffix, body, key, original] of [
      ['', treeBody, treeKey, tree],
      ['', fileBody, fileKey, file],
      [`/${fileId}/restore`, restoreBody, restoreKey, restored],
      [deleteSuffix, {}, deleteKey, deleted],
    ] as const) {
      const replay = await snapshotPost(app, base, suffix, body, key).expect(original.status);
      expect(replay.body).toEqual(original.body);
      expect(replay.headers['x-request-id']).toBe(original.headers['x-request-id']);
    }
    await snapshotPost(app, base, `/${fileId}/restore`, { path: '/after-restart', ifAbsent: true }).expect(
      201,
    );
    expect((await http().get(`${base}/content`).query({ path: '/after-restart' }).expect(200)).body).toEqual(
      bytes,
    );
    await http().get(`${base}/snapshots/${deletedSnapshot.body.snapshotId}`).expect(404);
  });

  it('조건부 mutation·content 오류 receipt를 앱과 DB 연결 재생성 뒤 최초 body와 X-Request-Id로 재생한다', async () => {
    const http = () => request(app.getHttpServer());
    const ns = await http()
      .post('/api/v1/namespaces')
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'error-receipt-restart' })
      .expect(201);
    const base = `/api/v1/namespaces/${ns.body.id}/fs`;
    await http()
      .post(`${base}/content`)
      .query({ path: '/doc' })
      .set('Content-Type', 'text/plain')
      .send('first')
      .expect(201);
    const statAtConflict = (await http().get(`${base}/stat`).query({ path: '/doc' }).expect(200)).body;
    const mutate = (key: string, body: string) =>
      http()
        .post(`${base}/mutations`)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', 'error-receipt')
        .send(body);
    const upload = (key: string, path: string, headers: Record<string, string>) => {
      let call = http()
        .post(`${base}/content/conditional`)
        .query({ path })
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', 'error-receipt')
        .set('Content-Type', 'application/octet-stream');
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      return call.send(Buffer.from('body'));
    };
    const staleKey = randomUUID();
    const staleBody = JSON.stringify({
      kind: 'delete',
      path: '/doc',
      ifRevision: encodeRevision({ id: randomUUID(), version: 1 }),
    });
    const stale = await mutate(staleKey, staleBody).expect(412);
    expect(stale.body.current).toEqual(statAtConflict);
    const nfdKey = randomUUID();
    const nfdBody = '{"kind":"mkdir","path":"/e\\u0301","ifAbsent":true}';
    const nfd = await mutate(nfdKey, nfdBody).expect(400);
    expect(nfd.body.code).toBe('VFS_INVALID_PATH');
    const existsKey = randomUUID();
    const exists = await upload(existsKey, '/doc', { 'X-If-Absent': 'true' }).expect(412);
    expect(exists.body.current).toEqual(statAtConflict);
    const headerKey = randomUUID();
    const badHeader = await upload(headerKey, '/doc', { 'X-If-Absent': 'yes' }).expect(400);
    const missingParentKey = randomUUID();
    const missingParent = await upload(missingParentKey, '/parent/x', { 'X-If-Absent': 'true' }).expect(404);

    await http()
      .post(`${base}/content`)
      .query({ path: '/doc', force: true })
      .set('Content-Type', 'text/plain')
      .send('changed after the conflict')
      .expect(200);
    await http().post(`${base}/mkdir`).send({ path: '/parent' }).expect(201);
    const oldDataSource = app.get(DataSource);
    await app.close();
    expect(oldDataSource.isInitialized).toBe(false);
    app = await bootstrap();

    for (const [send, original] of [
      [() => mutate(staleKey, staleBody), stale],
      [() => mutate(nfdKey, nfdBody), nfd],
      [() => upload(existsKey, '/doc', { 'X-If-Absent': 'true' }), exists],
      [() => upload(headerKey, '/doc', { 'X-If-Absent': 'yes' }), badHeader],
      [() => upload(missingParentKey, '/parent/x', { 'X-If-Absent': 'true' }), missingParent],
    ] as const) {
      const replay = await send().expect(original.status);
      expect(replay.body).toEqual(original.body);
      expect(replay.headers['x-request-id']).toBe(original.headers['x-request-id']);
    }
    expect((await http().get(`${base}/stat`).query({ path: '/doc' }).expect(200)).body).not.toEqual(
      statAtConflict,
    );
    expect((await upload(headerKey, '/doc', { 'X-If-Absent': 'false' }).expect(409)).body.code).toBe(
      'MUTATION_KEY_REUSED',
    );
  });
});
