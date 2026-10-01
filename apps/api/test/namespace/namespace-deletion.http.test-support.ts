/**
 * 실제 PostgreSQL·SQLite와 메모리 object 저장소에서 삭제 후 HTTP 접근을 검증한다.
 * 규칙은 docs/design/13-namespace-deletion.md "접근과 이름 재사용". 결정은 api ADR-0032.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { VALID_API_KEYS } from '../../src/auth/auth.constants.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import {
  BLOB_STORAGE,
  STORAGE_CLIENT,
  STORAGE_PUBLIC_CLIENT,
  STORAGE_BUCKET,
} from '../../src/storage/storage.constants.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';
import { registerNamespaceDeletionAccessHttpTests } from './namespace-deletion.http.shared-tests.js';

/** 두 DB에서 같은 HTTP 차단 묶음을 등록한다. 외부 object storage는 실행하지 않는다. */
export function namespaceDeletionAccessSuite(sqlite: boolean): void {
  describe(`namespace 삭제 데이터 접근 (${sqlite ? 'SQLite' : 'PostgreSQL'})`, () => {
    let app: INestApplication;
    let container: StartedPostgreSqlContainer | undefined;
    let directory: string;
    let namespaceId: string;
    const previous = { ...process.env };
    const adminKey = 'deletion-access-test';
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'storix-deletion-access-'));
      if (sqlite) {
        if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
        process.env.STORIX_DB_SQLITE_PATH = join(directory, 'test.sqlite');
      } else {
        container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
        Object.assign(process.env, {
          STORIX_DB_HOST: container.getHost(),
          STORIX_DB_PORT: String(container.getPort()),
          STORIX_DB_USERNAME: container.getUsername(),
          STORIX_DB_PASSWORD: container.getPassword(),
          STORIX_DB_NAME: container.getDatabase(),
        });
      }
      process.env.STORIX_ADMIN_API_KEY = adminKey;
      process.env.STORIX_ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
      const db = await new DataSource({
        ...(sqlite
          ? { type: 'better-sqlite3' as const, database: process.env.STORIX_DB_SQLITE_PATH! }
          : { type: 'postgres' as const, url: container!.getConnectionUri() }),
        entities: [NamespaceEntity, VfsNodeEntity],
        migrations: ALL_MIGRATIONS,
        migrationsTransactionMode: 'each',
      }).initialize();
      try {
        await db.runMigrations();
        namespaceId = (
          await new NamespaceProvisioningRepository(db).createWithRoot(
            `access-${randomUUID()}`,
            'NONE',
            'PUBLIC',
          )
        ).id;
      } finally {
        await db.destroy();
      }
      const objects = new Map<string, Buffer>();
      const storage: BlobStorage = {
        async put(key, source) {
          const chunks: Buffer[] = [];
          for await (const chunk of source) chunks.push(Buffer.from(chunk));
          objects.set(key, Buffer.concat(chunks));
        },
        async get(key) {
          const bytes = objects.get(key);
          if (!bytes) throw new Error('Object missing');
          return Readable.from([bytes]);
        },
        async delete(key) {
          objects.delete(key);
        },
        async *list(prefix = '') {
          for (const key of objects.keys())
            if (key.startsWith(prefix)) yield { key, lastModified: new Date() };
        },
        async getPresignedUrl(key) {
          return `https://storage.example/${key}`;
        },
      };
      const module = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule, VfsModule],
      })
        .overrideProvider(VALID_API_KEYS)
        .useValue(['deletion-access-service'])
        .overrideProvider(STORAGE_CLIENT)
        .useValue(null)
        .overrideProvider(STORAGE_PUBLIC_CLIENT)
        .useValue(null)
        .overrideProvider(STORAGE_BUCKET)
        .useValue('test')
        .overrideProvider(BLOB_STORAGE)
        .useValue(storage)
        .overrideProvider(CapabilityService)
        .useValue(
          new CapabilityService({
            globalAllowedCapabilities: ['change-feed'],
            namespaceAllowedCapabilities: { [namespaceId]: ['change-feed'] },
          }),
        )
        .compile();
      app = module.createNestApplication({ bodyParser: false });
      configureBodyParsers(app);
      await app.init();
    });
    afterAll(async () => {
      if (app) await app.close();
      if (container) await container.stop();
      if (directory) await rm(directory, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    });
    registerNamespaceDeletionAccessHttpTests({
      app: () => app,
      namespace: () => namespaceId,
      adminKey,
      serviceKey: 'deletion-access-service',
    });
  });
}
