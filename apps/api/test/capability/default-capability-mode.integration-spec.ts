import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { startS3Container, type StartedS3Container } from '../storage/s3-container.test-support.js';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';

const API_KEY = 'default-capability-mode-key';

// 설정 파일에 namespace를 나열하지 않고 defaultEnabledCapabilities만 둔 전역 모드를 실제 설정 파일로 부팅한다.
describe('capability 기본 활성 모드(PostgreSQL + S3)', () => {
  const previousEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let s3: StartedS3Container;
  let migrations: DataSource;
  let directory: string;
  let app: INestApplication | undefined;

  async function writeConfig(namespaces: Record<string, string[]>): Promise<void> {
    await writeFile(
      join(directory, 'capabilities.json'),
      JSON.stringify({
        globalAllowedCapabilities: ['resumable-upload'],
        namespaceAllowedCapabilities: namespaces,
        defaultEnabledCapabilities: ['resumable-upload'],
      }),
    );
    await writeFile(
      join(directory, 'upload-sessions.json'),
      JSON.stringify({
        global: { maxStagedBytes: '1024', maxActiveSessions: 4, partSizeBytes: 4 },
        namespaces: {},
      }),
    );
  }

  async function boot(): Promise<{ app: INestApplication; namespaceLookups: number }> {
    if (app) await app.close();
    const query = jest.spyOn(DataSource.prototype, 'query');
    query.mockClear();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule, VfsModule],
    }).compile();
    const lookups = query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /FROM namespace WHERE id/i.test(sql),
    ).length;
    query.mockRestore();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(app);
    await app.init();
    return { app, namespaceLookups: lookups };
  }

  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${API_KEY}`);

  async function createNamespace(name: string): Promise<string> {
    const response = await auth(request(app!.getHttpServer()).post('/api/v2/namespaces'))
      .set('Idempotency-Key', randomUUID())
      .send({ name })
      .expect(201);
    return response.body.id as string;
  }

  beforeAll(async () => {
    [postgres, s3] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      startS3Container(),
    ]);
    directory = await mkdtemp(join(tmpdir(), 'storix-default-capability-'));
    Object.assign(process.env, {
      STORIX_DB_HOST: postgres.getHost(),
      STORIX_DB_PORT: String(postgres.getPort()),
      STORIX_DB_USERNAME: postgres.getUsername(),
      STORIX_DB_PASSWORD: postgres.getPassword(),
      STORIX_DB_NAME: postgres.getDatabase(),
      STORIX_STORAGE_ENDPOINT: s3.getHost(),
      STORIX_STORAGE_PORT: String(s3.getPort()),
      STORIX_STORAGE_USE_SSL: 'false',
      STORIX_STORAGE_ACCESS_KEY: s3.getUsername(),
      STORIX_STORAGE_SECRET_KEY: s3.getPassword(),
      STORIX_STORAGE_BUCKET: 'storix-default-capability',
      STORIX_API_KEY: API_KEY,
      STORIX_VFS_CAPABILITIES_CONFIG_PATH: join(directory, 'capabilities.json'),
      STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: join(directory, 'upload-sessions.json'),
    });
    await createTestBucket(createTestS3Client(s3), 'storix-default-capability');
    migrations = new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
      migrations: ALL_MIGRATIONS,
    });
    await migrations.initialize();
    await migrations.runMigrations();
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (migrations?.isInitialized) await migrations.destroy();
    await Promise.all([postgres?.stop(), s3?.stop()]);
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });

  it('namespace를 나열하지 않은 설정은 시작 시 namespace 존재 조회를 하지 않는다', async () => {
    await writeConfig({});
    const started = await boot();
    expect(started.namespaceLookups).toBe(0);
  });

  it('재시작 없이 새로 만든 namespace에서 session 생성부터 finalize까지 동작한다', async () => {
    await writeConfig({});
    await boot();
    const id = await createNamespace('default-mode-new');
    const capabilities = await auth(
      request(app!.getHttpServer()).get(`/api/v2/namespaces/${id}/capabilities`),
    ).expect(200);
    expect(capabilities.body.capabilities).toEqual(['resumable-upload']);

    const base = `/api/v2/namespaces/${id}/fs/upload-sessions`;
    const created = await auth(request(app!.getHttpServer()).post(base))
      .set('X-Mutation-Scope', 'default-mode')
      .set('Idempotency-Key', randomUUID())
      .send({ path: '/new.bin', sizeBytes: '6', mimeType: 'application/octet-stream', ifAbsent: true })
      .expect(201);
    const sessionId = created.body.sessionId as string;
    await auth(request(app!.getHttpServer()).put(`${base}/${sessionId}/parts/0`))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('abcd'))
      .expect(200);
    await auth(request(app!.getHttpServer()).put(`${base}/${sessionId}/parts/1`))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('ef'))
      .expect(200);
    await auth(request(app!.getHttpServer()).post(`${base}/${sessionId}/complete`)).expect(201);
    const content = await auth(
      request(app!.getHttpServer()).get(`/api/v2/namespaces/${id}/fs/content`).query({ path: '/new.bin' }),
    ).expect(200);
    expect(content.body.toString()).toBe('abcdef');
  });

  it('namespace 항목에 빈 목록을 두면 그 namespace만 비활성이고 한도는 전역 값을 쓴다', async () => {
    await writeConfig({});
    await boot();
    const disabledId = await createNamespace('default-mode-disabled');
    const enabledId = await createNamespace('default-mode-enabled');
    await writeConfig({ [disabledId]: [] });
    // 명시 항목은 일괄 조회 한 번으로 확인한다(항목 수와 무관).
    expect((await boot()).namespaceLookups).toBe(1);

    const disabled = await auth(
      request(app!.getHttpServer()).get(`/api/v2/namespaces/${disabledId}/capabilities`),
    ).expect(200);
    expect(disabled.body.capabilities).toEqual([]);
    const enabled = await auth(
      request(app!.getHttpServer()).get(`/api/v2/namespaces/${enabledId}/capabilities`),
    ).expect(200);
    expect(enabled.body.capabilities).toEqual(['resumable-upload']);

    const blocked = await auth(
      request(app!.getHttpServer()).post(`/api/v2/namespaces/${disabledId}/fs/upload-sessions`),
    )
      .set('X-Mutation-Scope', 'default-mode')
      .set('Idempotency-Key', randomUUID())
      .send({ path: '/x.bin', sizeBytes: '4', mimeType: 'application/octet-stream', ifAbsent: true })
      .expect(409);
    expect(blocked.body.code).toBe('VFS_FEATURE_DISABLED');
  });

  it('존재하지 않는 namespace를 명시하면 여전히 시작을 거부한다', async () => {
    await writeConfig({ [randomUUID()]: ['resumable-upload'] });
    await expect(boot()).rejects.toThrow(/unknown namespace ID/);
  });
});
