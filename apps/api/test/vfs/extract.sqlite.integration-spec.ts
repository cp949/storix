// SQLite migration, 실제 VFS repository, HTTP route와 range를 지원하는 메모리 BlobStorage로 extract HTTP 계약을 실행한다.
// 시나리오 본문은 extract-http.test-support.ts다. PostgreSQL 전용 fixture를 쓰지 않는다.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';
import { MASTER_KEY } from '../../src/encryption/encryption.constants.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import type { ArchiveGate } from '../../src/vfs/archive-gate.js';
import { EXTRACT_GATE } from '../../src/vfs/extract-config.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { registerExtractHttpScenarios } from './extract-http.test-support.js';

const API_KEY = 'extract-sqlite-integration-key';

describe('extract HTTP SQLite 계약 검증', () => {
  let directory: string;
  let app: INestApplication;
  const objects = new Map<string, Buffer>();
  const previous = { ...process.env };

  /** range를 지원하는 메모리 저장소다. 테스트가 spy로 실패를 주입한다. */
  const storage = {
    async get(key: string, range?: { start: number; end?: number }) {
      const data = objects.get(key);
      if (!data) throw new Error(`missing object: ${key}`);
      return Readable.from([range ? data.subarray(range.start, (range.end ?? data.length - 1) + 1) : data]);
    },
    async put(key: string, stream: NodeJS.ReadableStream) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async *list() {
      for (const key of [...objects.keys()]) yield { key, lastModified: new Date() };
    },
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

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'storix-extract-'));
    Object.assign(process.env, {
      STORIX_DB_DRIVER: 'sqlite',
      STORIX_DB_SQLITE_PATH: join(directory, 'extract.sqlite'),
      STORIX_API_KEY: API_KEY,
      STORIX_ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      STORIX_STORAGE_ENDPOINT: '127.0.0.1',
      STORIX_STORAGE_PORT: '9000',
      STORIX_STORAGE_ACCESS_KEY: 'test-access',
      STORIX_STORAGE_SECRET_KEY: 'test-secret',
      STORIX_STORAGE_BUCKET: 'extract-test',
      STORIX_EXTRACT_MAX_SECONDS: '60',
      STORIX_ORPHAN_GRACE_PERIOD: '86400',
    });
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    const migration = new DataSource({
      type: 'better-sqlite3',
      database: join(directory, 'extract.sqlite'),
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await migration.initialize();
    await migration.runMigrations();
    await migration.destroy();
    const capabilities = new CapabilityService({
      globalAllowedCapabilities: ['extract'],
      defaultEnabledCapabilities: ['extract'],
      namespaceAllowedCapabilities: {},
    });
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule, VfsModule],
    })
      .overrideProvider(MASTER_KEY)
      .useValue(Buffer.from('ab'.repeat(32), 'hex'))
      .overrideProvider(BLOB_STORAGE)
      .useValue(storage)
      .overrideProvider(CapabilityService)
      .useValue(capabilities)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    // 운영 main.ts처럼 전역 필터를 걸어 parser 단계 오류도 공개 오류 계약으로 응답하게 한다.
    app.useGlobalFilters(new DomainErrorFilter());
    configureBodyParsers(app);
    await app.init();
    await app.listen(0);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  registerExtractHttpScenarios({
    server: () => app.getHttpServer(),
    headers: () => ({ Authorization: `Bearer ${API_KEY}` }),
    createNamespace: async (options = {}) => {
      const response = await request(app.getHttpServer())
        .post('/api/v2/namespaces')
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          name: `extract-${randomUUID()}`,
          ...(options.encrypted ? { encryptionPolicy: 'ENCRYPTED' } : {}),
        })
        .expect(201);
      const id = response.body.id as string;
      if (options.trashEnabled)
        await app.get(DataSource).getRepository(NamespaceEntity).update({ id }, { trashEnabled: true });
      return id;
    },
    dataSource: () => app.get(DataSource),
    storage: () => storage,
    storageKeys: async () => [...objects.keys()],
    capabilities: () => app.get(CapabilityService),
    gate: () => app.get<ArchiveGate>(EXTRACT_GATE),
  });
});
