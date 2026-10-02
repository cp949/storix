import { registerNamespaceDeletionHttpTests } from './namespace-deletion.http.shared-tests.js';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { NamespaceCreationReceiptWriter } from '../../src/persistence/namespace-creation-receipt.writer.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { registerNamespaceListPageTests } from './namespace-list.http.shared-tests.js';
import { registerNamespacePurgeHttpTests } from './namespace-purge.http.shared-tests.js';
import { registerNamespaceReceiptRetentionTests } from './namespace-receipt-retention.http.shared-tests.js';
import { registerNamespaceTrashPolicyHttpTests } from './namespace-trash-policy.http.shared-tests.js';

type RowCount = { count: number };

describe('Namespace HTTP contract (SQLite)', () => {
  let directory: string;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  const previousEnv = { ...process.env };

  async function bootstrap(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), NamespaceModule],
    }).compile();
    const next = moduleRef.createNestApplication();
    await next.init();
    return next;
  }

  async function namespaceCounts(name: string) {
    const namespaces = (await migrationDataSource.query(
      'SELECT COUNT(*) AS count FROM namespace WHERE name = ?',
      [name],
    )) as RowCount[];
    const roots = (await migrationDataSource.query(
      `SELECT COUNT(*) AS count FROM vfs_node n
       INNER JOIN namespace ns ON ns.id = n.namespace_id
       WHERE ns.name = ? AND n.parent_id IS NULL AND n.type = 'DIRECTORY' AND n.name = ''`,
      [name],
    )) as RowCount[];
    return { namespaces: Number(namespaces[0].count), roots: Number(roots[0].count) };
  }

  async function receiptCount(key: string): Promise<number> {
    const rows = (await migrationDataSource.query(
      'SELECT COUNT(*) AS count FROM idempotency_key WHERE key = ?',
      [key],
    )) as RowCount[];
    return Number(rows[0].count);
  }

  registerNamespaceReceiptRetentionTests({
    app: () => app,
    backdate: (key, days) =>
      migrationDataSource
        .query("UPDATE idempotency_key SET created_at = datetime('now', ?) WHERE key = ?", [
          `-${days} days`,
          key,
        ])
        .then(() => undefined),
    receiptExists: async (key) => (await receiptCount(key)) > 0,
  });

  registerNamespacePurgeHttpTests({
    app: () => app,
    adminKey: 'namespace-admin-secret',
    createNamespace: async (name, key) => {
      const response = await request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', key)
        .send(name === null ? {} : { name })
        .expect(201);
      return response.body.id as string;
    },
    forceCompleted: async (namespaceId, days) => {
      await migrationDataSource.query('DELETE FROM vfs_node WHERE namespace_id = ?', [namespaceId]);
      await migrationDataSource.query("UPDATE namespace SET status = 'DELETED' WHERE id = ?", [namespaceId]);
      await migrationDataSource.query(
        "UPDATE namespace_deletion SET phase = 'COMPLETED', completed_at = datetime('now', ?) WHERE namespace_id = ?",
        [`-${days} days`, namespaceId],
      );
    },
  });

  registerNamespaceListPageTests({
    app: () => app,
    createNamespace: async (name, key) => {
      const response = await request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', key)
        .send(name === null ? {} : { name })
        .expect(201);
      return response.body.id as string;
    },
    query: (sql, params) => migrationDataSource.query(sql.replace(/\$\d+/g, '?'), params),
  });

  registerNamespaceTrashPolicyHttpTests({
    app: () => app,
    adminKey: 'namespace-admin-secret',
    createNamespace: async (name, key) => {
      const response = await request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', key)
        .send(name === null ? {} : { name })
        .expect(201);
      return response.body.id as string;
    },
  });

  registerNamespaceDeletionHttpTests({
    app: () => app,
    adminKey: 'namespace-admin-secret',
    createNamespace: async (name, key) => {
      const response = await request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', key)
        .send(name === null ? {} : { name })
        .expect(201);
      return response.body.id as string;
    },
  });

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('Run with STORIX_DB_DRIVER=sqlite');
    directory = await mkdtemp(join(tmpdir(), 'storix-namespace-http-'));
    process.env.STORIX_DB_SQLITE_PATH = join(directory, 'namespace.sqlite');
    process.env.STORIX_ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
    process.env.STORIX_ADMIN_API_KEY = 'namespace-admin-secret';

    migrationDataSource = new DataSource({
      type: 'better-sqlite3',
      database: process.env.STORIX_DB_SQLITE_PATH,
      synchronize: false,
      migrationsTransactionMode: 'each',
      migrations: ALL_MIGRATIONS,
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    app = await bootstrap();
  }, 60000);

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      try {
        if (migrationDataSource?.isInitialized) await migrationDataSource.destroy();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
        Object.assign(process.env, previousEnv);
      }
    }
  });

  it('동일 key·동일 body 동시 요청은 최초 201 body와 namespace/root/receipt 하나를 반환한다', async () => {
    const key = 'namespace-sqlite-concurrent-same-body';
    const body = { name: 'namespace-sqlite-concurrent-same-body' };
    const responses = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer()).post('/api/v2/namespaces').set('Idempotency-Key', key).send(body),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(responses[1].body).toEqual(responses[0].body);
    expect(await namespaceCounts(body.name)).toEqual({ namespaces: 1, roots: 1 });
    expect(await receiptCount(key)).toBe(1);
  });

  it('동일 key·상이 body 동시 요청은 하나의 201과 IDEMPOTENCY_KEY_REUSED 422를 반환한다', async () => {
    const key = 'namespace-sqlite-concurrent-different-body';
    const bodies = [
      { name: 'namespace-sqlite-concurrent-different-body-a' },
      { name: 'namespace-sqlite-concurrent-different-body-b' },
    ];
    const responses = await Promise.all(
      bodies.map((body) =>
        request(app.getHttpServer()).post('/api/v2/namespaces').set('Idempotency-Key', key).send(body),
      ),
    );

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 422]);
    expect(responses.find(({ status }) => status === 422)?.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    const namespaceNames = await Promise.all(bodies.map(({ name }) => namespaceCounts(name)));
    expect(namespaceNames.reduce((count, rows) => count + rows.namespaces, 0)).toBe(1);
    expect(namespaceNames.reduce((count, rows) => count + rows.roots, 0)).toBe(1);
    expect(await receiptCount(key)).toBe(1);
  });

  it('다른 key·같은 name 충돌은 NAMESPACE_ALREADY_EXISTS 409이며 두 번째 namespace/root를 만들지 않는다', async () => {
    const name = 'namespace-sqlite-name-collision';
    await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'namespace-sqlite-name-owner')
      .send(name === null ? {} : { name })
      .expect(201);

    const collision = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', 'namespace-sqlite-name-contender')
      .send(name === null ? {} : { name })
      .expect(409);
    expect(collision.body).toMatchObject({ code: 'NAMESPACE_ALREADY_EXISTS' });
    expect(await namespaceCounts(name)).toEqual({ namespaces: 1, roots: 1 });
    expect(await receiptCount('namespace-sqlite-name-owner')).toBe(1);
    expect(await receiptCount('namespace-sqlite-name-contender')).toBe(1);
  });

  it('receipt 저장 실패는 namespace/root도 롤백하고 앱 재시작 뒤 같은 key를 성공시킨다', async () => {
    const key = 'namespace-sqlite-receipt-failure-restart';
    const body = { name: 'namespace-sqlite-receipt-failure-restart' };
    const receiptWriter = app.get(NamespaceCreationReceiptWriter);
    jest.spyOn(receiptWriter, 'save').mockRejectedValueOnce(new Error('injected receipt write failure'));

    const failed = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', key)
      .send(body);
    const beforeRestart = await namespaceCounts(body.name);
    const receiptBeforeRestart = await receiptCount(key);

    await app.close();
    app = await bootstrap();

    const retry = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', key)
      .send(body);
    expect({
      failedStatus: failed.status,
      beforeRestart,
      receiptBeforeRestart,
      retryStatus: retry.status,
      retryName: retry.body.name,
      afterRestart: await namespaceCounts(body.name),
      receiptAfterRestart: await receiptCount(key),
    }).toEqual({
      failedStatus: 500,
      beforeRestart: { namespaces: 0, roots: 0 },
      receiptBeforeRestart: 0,
      retryStatus: 201,
      retryName: body.name,
      afterRestart: { namespaces: 1, roots: 1 },
      receiptAfterRestart: 1,
    });
  });
});
