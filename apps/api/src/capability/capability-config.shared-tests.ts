import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';

// PostgreSQL(capability-config.integration-spec.ts)과 SQLite(capability-config.sqlite.integration-spec.ts)
// 실행이 같은 부팅 시나리오를 공유한다. SQLite 쪽은 test:integration:sqlite 패턴에 맞는 파일에서만 돈다.
export function runCapabilityConfigBootTests(driver: 'postgres' | 'sqlite'): void {
  let container: StartedPostgreSqlContainer | undefined;
  let dataSource: DataSource;
  let directory: string;
  let namespaceId: string;
  let savedEnv: NodeJS.ProcessEnv;
  const sqlite = driver === 'sqlite';

  beforeAll(async () => {
    if (sqlite && process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error('STORIX_DB_DRIVER=sqlite가 필요합니다');
    }
    savedEnv = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), 'storix-capability-boot-'));
    if (sqlite) {
      process.env.STORIX_DB_SQLITE_PATH = join(directory, 'storix.sqlite');
      dataSource = new DataSource({ type: 'better-sqlite3', database: process.env.STORIX_DB_SQLITE_PATH,
        migrations: ALL_MIGRATIONS, migrationsTransactionMode: 'each' });
    } else {
      container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
      Object.assign(process.env, {
        STORIX_DB_HOST: container.getHost(),
        STORIX_DB_PORT: String(container.getPort()),
        STORIX_DB_USERNAME: container.getUsername(),
        STORIX_DB_PASSWORD: container.getPassword(),
        STORIX_DB_NAME: container.getDatabase(),
      });
      dataSource = new DataSource({ type: 'postgres', url: container.getConnectionUri(), migrations: ALL_MIGRATIONS });
    }
    Object.assign(process.env, {
      STORIX_STORAGE_ENDPOINT: 'localhost',
      STORIX_STORAGE_ACCESS_KEY: 'test-access',
      STORIX_STORAGE_SECRET_KEY: 'test-secret',
      STORIX_STORAGE_BUCKET: 'test-bucket',
      STORIX_API_KEY: 'test-api-key',
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    namespaceId = randomUUID();
    await dataSource.query(
      sqlite ? 'INSERT INTO namespace (id, name) VALUES (?, ?)' : 'INSERT INTO namespace (id, name) VALUES ($1, $2)',
      [namespaceId, 'capability-existing-namespace'],
    );
  }, 120000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    process.env = savedEnv;
  });

  async function bootWithNamespace(id: string): Promise<void> {
    const path = join(directory, 'capabilities.json');
    await writeFile(path, JSON.stringify({ globalAllowedCapabilities: [], namespaceAllowedCapabilities: { [id]: [] } }));
    process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH = path;
    const { AppModule } = await import('../app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    try {
      await app.init();
    } finally {
      await app.close();
    }
  }

  it('기존 namespace ID는 AppModule 부팅에 성공한다', async () => {
    await expect(bootWithNamespace(namespaceId)).resolves.toBeUndefined();
  });

  it('존재하지 않는 namespace ID는 AppModule 부팅을 거부한다', async () => {
    await expect(bootWithNamespace(randomUUID())).rejects.toThrow(/unknown namespace ID/);
  });
}
