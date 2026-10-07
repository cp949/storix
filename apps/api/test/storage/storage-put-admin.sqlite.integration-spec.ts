/** 실제 SQLite와 Nest 운영 CLI 모듈에서 종료 확인 기록을 검증한다. 규칙은 api ADR-0045다. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';
import { StoragePutAdminModule } from '../../src/storage/storage-put-admin.module.js';
import { StoragePutAdminService } from '../../src/storage/storage-put-admin.service.js';

// CLI가 별도의 ConfigModule 없이 부팅되고 실제 DB에 운영자의 확인 근거를 보존해야 한다.
describe('storage PUT 운영 모듈 (SQLite)', () => {
  let directory: string;
  let dataSource: DataSource;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('STORIX_DB_DRIVER=sqlite가 필요하다');
    directory = await mkdtemp(join(tmpdir(), 'storix-put-admin-test-'));
    process.env.STORIX_DB_SQLITE_PATH = join(directory, 'metadata.sqlite');
    process.env.STORIX_STORAGE_ENDPOINT = '127.0.0.1';
    process.env.STORIX_STORAGE_ACCESS_KEY = 'local-test';
    process.env.STORIX_STORAGE_SECRET_KEY = 'local-test';
    process.env.STORIX_STORAGE_BUCKET = 'local-test';
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: process.env.STORIX_DB_SQLITE_PATH,
      migrationsTransactionMode: 'each',
      entities: [],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    process.env = previousEnv;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('운영 CLI 모듈 자체가 storage 설정을 제공해 부팅된다', async () => {
    const app = await NestFactory.createApplicationContext(StoragePutAdminModule, {
      abortOnError: false,
      logger: false,
    });
    try {
      expect(app.get(StoragePutAdminService)).toBeInstanceOf(StoragePutAdminService);
    } finally {
      await app.close();
    }
  });

  it('종료 확인 근거를 실제 실행 행에 영속 저장한다', async () => {
    const repository = new StoragePutOwnershipRepository(dataSource);
    const executionId = randomUUID();
    await repository.registerExecution(executionId);
    await repository.confirmExecutionStopped(
      executionId,
      'container review-writer의 실행 incarnation 종료를 확인함',
    );
    const [row] = (await dataSource.query('SELECT * FROM storage_put_execution WHERE execution_id = ?', [
      executionId,
    ])) as Array<{ stopped_confirmation_evidence?: string }>;
    expect(row.stopped_confirmation_evidence).toBe(
      'container review-writer의 실행 incarnation 종료를 확인함',
    );
  });
});
