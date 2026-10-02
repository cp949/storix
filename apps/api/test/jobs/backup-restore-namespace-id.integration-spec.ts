import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BackupJob } from '../../src/jobs/backup.job.js';
import { PgDumpCliTool } from '../../src/jobs/pg-dump-cli.tool.js';
import { RestoreJob } from '../../src/jobs/restore.job.js';
import { BackupRepository } from '../../src/persistence/backup.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import {
  BACKUP_RESTORE_ENTITIES,
  registerBackupRestoreNamespaceIdTests,
} from './backup-restore-namespace-id.shared-tests.js';

// 최대 길이 prefix namespace ID가 pg_dump/pg_restore를 거쳐도 보존되는지 확인한다.
// 복구 대상은 마이그레이션만 적용한 별도 데이터베이스다.
describe('Backup/Restore namespace ID (Postgres)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let s3Container: StartedS3Container;
  let sourceDs: DataSource;
  let targetDs: DataSource;
  let sourceStorage: S3BlobStorage;
  let targetStorage: S3BlobStorage;
  let backupRootDir: string;
  const targetDatabase = 'storix_restored';

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

  function connectionValues(database: string): Record<string, string> {
    return {
      STORIX_DB_HOST: pgContainer.getHost(),
      STORIX_DB_PORT: String(pgContainer.getPort()),
      STORIX_DB_USERNAME: pgContainer.getUsername(),
      STORIX_DB_PASSWORD: pgContainer.getPassword(),
      STORIX_DB_NAME: database,
    };
  }

  beforeAll(async () => {
    [pgContainer, s3Container] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      startS3Container(),
    ]);
    sourceDs = new DataSource({
      type: 'postgres',
      url: pgContainer.getConnectionUri(),
      synchronize: false,
      entities: BACKUP_RESTORE_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await sourceDs.initialize();
    await sourceDs.runMigrations();
    await sourceDs.query(`CREATE DATABASE ${targetDatabase}`);
    const targetUrl = new URL(pgContainer.getConnectionUri());
    targetUrl.pathname = `/${targetDatabase}`;
    targetDs = new DataSource({
      type: 'postgres',
      url: targetUrl.toString(),
      synchronize: false,
      entities: BACKUP_RESTORE_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await targetDs.initialize();
    await targetDs.runMigrations();

    const client = createTestS3Client(s3Container);
    await createTestBucket(client, 'storix-restore-id-source');
    await createTestBucket(client, 'storix-restore-id-target');
    sourceStorage = new S3BlobStorage(client, 'storix-restore-id-source', null);
    targetStorage = new S3BlobStorage(client, 'storix-restore-id-target', null);
    backupRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-id-'));
  }, 240000);

  afterAll(async () => {
    await targetDs?.destroy();
    await sourceDs?.destroy();
    await Promise.all([pgContainer?.stop(), s3Container?.stop()]);
    if (backupRootDir) await fs.rm(backupRootDir, { recursive: true, force: true });
  });

  registerBackupRestoreNamespaceIdTests(
    {
      sourceDs: () => sourceDs,
      sourceStorage: () => sourceStorage,
      targetStorage: () => targetStorage,
      targetDs: () => targetDs,
      isPostgres: true,
      createBackupJob: (rootDir) => {
        const values = { ...connectionValues(pgContainer.getDatabase()), STORIX_BACKUP_DIR: rootDir };
        return new BackupJob(
          sourceStorage,
          new BackupRepository(sourceDs),
          new PgDumpCliTool(makeConfig(values)),
          makeConfig(values),
        );
      },
      createRestoreJob: (backupDir) => {
        const values = {
          ...connectionValues(targetDatabase),
          STORIX_RESTORE_SOURCE_DIR: backupDir,
          STORIX_RESTORE_FORCE: 'false',
        };
        return new RestoreJob(
          targetStorage,
          new BackupRepository(targetDs),
          new PgDumpCliTool(makeConfig(values)),
          makeConfig(values),
        );
      },
      reopenTarget: async () => targetDs,
    },
    () => backupRootDir,
  );
});
