import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { RestoreJob } from '../../src/jobs/restore.job.js';
import { SqliteDumpTool } from '../../src/jobs/sqlite-dump.tool.js';
import { BackupRepository } from '../../src/persistence/backup.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';

// 대상 DB가 손상됐거나 migrate 전이어도 복구를 다시 실행할 수 있는지 실제 SQLite 파일로 확인한다.
// 스토리지는 이 검증과 무관하므로 비어 있는 대역을 쓴다.
describe('SQLite 복구 대상 상태', () => {
  const entities = [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity];
  let workDir: string;
  let dbPath: string;
  let backupDir: string;
  let migratedSize: number;

  function makeConfig(values: Record<string, string>): ConfigService {
    return {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService;
  }

  async function runRestore(force: boolean): Promise<void> {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      entities,
    });
    await dataSource.initialize();
    try {
      const storage = {
        list: () => (async function* () {})(),
        put: async () => undefined,
        delete: async () => undefined,
      } as unknown as BlobStorage;
      await new RestoreJob(
        storage,
        new BackupRepository(dataSource),
        new SqliteDumpTool(makeConfig({ STORIX_DB_SQLITE_PATH: dbPath })),
        makeConfig({ STORIX_RESTORE_SOURCE_DIR: backupDir, STORIX_RESTORE_FORCE: String(force) }),
      ).run();
    } finally {
      await dataSource.destroy();
    }
  }

  async function restoredNamespaceNames(): Promise<string[]> {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      entities,
    });
    await dataSource.initialize();
    try {
      return (await dataSource.getRepository(NamespaceEntity).find()).map((row) => row.name!);
    } finally {
      await dataSource.destroy();
    }
  }

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error(
        'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 엔티티 컬럼 타입이 postgres 값으로 고정돼 의미가 없다',
      );
    }
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-target-sqlite-'));
    // 백업: migrate된 DB에 namespace 하나를 넣고 VACUUM INTO로 덤프한다.
    const sourcePath = path.join(workDir, 'source.sqlite');
    const source = new DataSource({
      type: 'better-sqlite3',
      database: sourcePath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities,
      migrations: ALL_MIGRATIONS,
    });
    await source.initialize();
    await source.runMigrations();
    const namespaces = source.getRepository(NamespaceEntity);
    await namespaces.save(namespaces.create({ name: 'backup-fixture-ns', encryptionPolicy: 'NONE' }));
    await source.destroy();
    backupDir = path.join(workDir, 'backup');
    await new SqliteDumpTool(makeConfig({ STORIX_DB_SQLITE_PATH: sourcePath })).dump(
      path.join(backupDir, 'storix.sqlite'),
    );
    migratedSize = (await fs.stat(sourcePath)).size;
  }, 60000);

  beforeEach(() => {
    dbPath = path.join(workDir, `target-${Math.random().toString(36).slice(2)}.sqlite`);
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('복사가 중간에 끊겨 잘린 대상은 force 복구로 되살린다', async () => {
    await fs.copyFile(path.join(backupDir, 'storix.sqlite'), dbPath);
    await fs.truncate(dbPath, Math.floor(migratedSize / 2));

    await runRestore(true);

    await expect(restoredNamespaceNames()).resolves.toEqual(['backup-fixture-ns']);
  });

  it('잘린 대상은 force가 없으면 SQLITE_CORRUPT를 그대로 던지고 파일을 바꾸지 않는다', async () => {
    await fs.copyFile(path.join(backupDir, 'storix.sqlite'), dbPath);
    await fs.truncate(dbPath, Math.floor(migratedSize / 2));
    const before = await fs.readFile(dbPath);

    await expect(runRestore(false)).rejects.toMatchObject({ driverError: { code: 'SQLITE_CORRUPT' } });

    expect((await fs.readFile(dbPath)).equals(before)).toBe(true);
  });

  it('SQLite 파일이 아닌 대상은 force 복구로 되살린다', async () => {
    await fs.writeFile(dbPath, 'this is not a sqlite database file'.repeat(200));

    await runRestore(true);

    await expect(restoredNamespaceNames()).resolves.toEqual(['backup-fixture-ns']);
  });

  it('migrate 전 대상(테이블 없음)은 force 없이도 복구한다', async () => {
    await expect(runRestore(false)).resolves.toBeUndefined();

    await expect(restoredNamespaceNames()).resolves.toEqual(['backup-fixture-ns']);
  });
});
