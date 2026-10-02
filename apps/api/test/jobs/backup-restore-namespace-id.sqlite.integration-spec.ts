import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BackupJob } from '../../src/jobs/backup.job.js';
import { RestoreJob } from '../../src/jobs/restore.job.js';
import { SqliteDumpTool } from '../../src/jobs/sqlite-dump.tool.js';
import { BackupRepository } from '../../src/persistence/backup.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import {
  BACKUP_RESTORE_ENTITIES,
  registerBackupRestoreNamespaceIdTests,
} from './backup-restore-namespace-id.shared-tests.js';

// 최대 길이 prefix namespace ID가 VACUUM INTO 사이드카와 파일 복사 복구를 거쳐도 보존되는지 확인한다.
// 복구 대상은 마이그레이션만 적용한 별도 SQLite 파일이다.
describe('Backup/Restore namespace ID (SQLite)', () => {
  let s3Container: StartedS3Container;
  let workDir: string;
  let sourcePath: string;
  let targetPath: string;
  let sourceDs: DataSource;
  let targetDs: DataSource;
  let sourceStorage: S3BlobStorage;
  let targetStorage: S3BlobStorage;
  let backupRootDir: string;

  function makeConfig(values: Record<string, string>): ConfigService {
    return {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => {
        const value = values[key];
        if (value === undefined) throw new Error(`설정값 없음: ${key}`);
        return value;
      },
    } as unknown as ConfigService;
  }

  function createDataSource(database: string, migrate: boolean): DataSource {
    return new DataSource({
      type: 'better-sqlite3',
      database,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: BACKUP_RESTORE_ENTITIES,
      ...(migrate ? { migrations: ALL_MIGRATIONS } : {}),
    });
  }

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error(
        'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 엔티티의 bytea/timestamptz 대체 상수가 postgres 값으로 고정돼 의미가 없다',
      );
    }
    s3Container = await startS3Container();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-id-sqlite-'));
    sourcePath = path.join(workDir, 'source.sqlite');
    targetPath = path.join(workDir, 'target.sqlite');
    for (const file of [sourcePath, targetPath]) {
      const ds = createDataSource(file, true);
      await ds.initialize();
      await ds.runMigrations();
      await ds.destroy();
    }
    sourceDs = createDataSource(sourcePath, false);
    await sourceDs.initialize();
    targetDs = createDataSource(targetPath, false);
    await targetDs.initialize();

    const client = createTestS3Client(s3Container);
    await createTestBucket(client, 'storix-restore-id-sqlite-source');
    await createTestBucket(client, 'storix-restore-id-sqlite-target');
    sourceStorage = new S3BlobStorage(client, 'storix-restore-id-sqlite-source', null);
    targetStorage = new S3BlobStorage(client, 'storix-restore-id-sqlite-target', null);
    backupRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-id-sqlite-out-'));
  }, 240000);

  afterAll(async () => {
    if (targetDs?.isInitialized) await targetDs.destroy();
    if (sourceDs?.isInitialized) await sourceDs.destroy();
    await s3Container?.stop();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
    if (backupRootDir) await fs.rm(backupRootDir, { recursive: true, force: true });
  });

  registerBackupRestoreNamespaceIdTests(
    {
      sourceDs: () => sourceDs,
      sourceStorage: () => sourceStorage,
      targetStorage: () => targetStorage,
      targetDs: () => targetDs,
      isPostgres: false,
      createBackupJob: (rootDir) =>
        new BackupJob(
          sourceStorage,
          new BackupRepository(sourceDs),
          new SqliteDumpTool(makeConfig({ STORIX_DB_SQLITE_PATH: sourcePath })),
          makeConfig({ STORIX_BACKUP_DIR: rootDir }),
        ),
      createRestoreJob: (backupDir) =>
        new RestoreJob(
          targetStorage,
          new BackupRepository(targetDs),
          new SqliteDumpTool(makeConfig({ STORIX_DB_SQLITE_PATH: targetPath })),
          makeConfig({ STORIX_RESTORE_SOURCE_DIR: backupDir, STORIX_RESTORE_FORCE: 'false' }),
        ),
      // 복구가 파일을 덮어썼으므로 연결을 닫고 새 연결로 읽는다.
      reopenTarget: async () => {
        await targetDs.destroy();
        targetDs = createDataSource(targetPath, false);
        await targetDs.initialize();
        return targetDs;
      },
    },
    () => backupRootDir,
  );
});
