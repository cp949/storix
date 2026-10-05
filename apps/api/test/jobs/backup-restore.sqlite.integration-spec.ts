import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import type { ConfigService } from '@nestjs/config';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import { DataSource } from 'typeorm';
import { BackupJob } from '../../src/jobs/backup.job.js';
import { RestoreJob } from '../../src/jobs/restore.job.js';
import { SqliteDumpTool } from '../../src/jobs/sqlite-dump.tool.js';
import { BackupRepository } from '../../src/persistence/backup.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';

// SQLite는 파일 하나가 곧 DB이므로, BackupJob/RestoreJob이 열어 둔 DataSource와
// SqliteDumpTool이 파일 경로로 직접 여는 better-sqlite3 연결이 같은 파일을
// 가리키게 한다(단일 프로세스 배포 모델과 일치). S3 스토리지는 Postgres 테스트와
// 동일하게 testcontainers로 띄운다 — object storage는 드라이버와 무관.
describe('Backup/Restore SQLite 통합', () => {
  let s3Container: StartedS3Container;
  let dbDir: string;
  let dbPath: string;
  let dataSource: DataSource;
  let backupRepository: BackupRepository;
  let storage: S3BlobStorage;
  let backupRootDir: string;
  const bucket = 'storix-backup-restore-sqlite-test';

  function makeConfig(values: Record<string, string>): ConfigService {
    return {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => {
        const value = values[key];
        if (value === undefined) {
          throw new Error(`설정값 없음: ${key}`);
        }
        return value;
      },
    } as unknown as ConfigService;
  }

  function sqliteConfig(): Record<string, string> {
    return { STORIX_DB_SQLITE_PATH: dbPath };
  }

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error(
        'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 엔티티의 bytea/timestamptz 대체 상수가 postgres 값으로 고정돼 의미가 없다',
      );
    }
    s3Container = await startS3Container();

    dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-backup-restore-sqlite-'));
    dbPath = path.join(dbDir, 'storix.sqlite');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    backupRepository = new BackupRepository(dataSource);

    const client = createTestS3Client(s3Container);
    await createTestBucket(client, bucket);
    storage = new S3BlobStorage(client, bucket, null);

    backupRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-backup-restore-sqlite-out-'));
  }, 180000);

  afterAll(async () => {
    await dataSource.destroy();
    await s3Container.stop();
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(backupRootDir, { recursive: true, force: true });
  });

  it('VACUUM INTO로 백업하고 파일 복사로 복구하면 namespace와 스토리지 object가 그대로 복원된다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await namespaceRepo.save(
      namespaceRepo.create({ name: 'sqlite-backup-fixture-ns', encryptionPolicy: 'NONE' }),
    );

    const storageKey = `blobs/ab/${randomUUID()}`;
    const content = Buffer.from('sqlite-backup-restore-test-content');
    await storage.put(storageKey, Readable.from(content));

    const backupJob = new BackupJob(
      storage,
      backupRepository,
      new SqliteDumpTool(makeConfig(sqliteConfig())),
      makeConfig({ STORIX_BACKUP_DIR: backupRootDir }),
    );
    const backupResult = await backupJob.run();

    expect(backupResult.copiedObjectCount).toBeGreaterThanOrEqual(1);
    const dumpStat = await fs.stat(path.join(backupResult.backupDir, 'storix.sqlite'));
    expect(dumpStat.size).toBeGreaterThan(0);

    // 대상을 완전히 비운 상태로 되돌려 복구를 검증한다.
    await dataSource.query('DELETE FROM namespace');
    for await (const item of storage.list()) {
      await storage.delete(item.key);
    }
    await dataSource.destroy();

    // RestoreJob은 실행(run) 시점에 BackupRepository로 "대상에 데이터가 있는가"를
    // 확인하는데, 이 확인은 dataSource가 열려 있어야 하므로 dataSource를 재연결하고
    // 새 backupRepository를 만든 뒤에야 RestoreJob을 생성한다. destroy된
    // dataSource를 물고 있는 backupRepository로 먼저 RestoreJob을 만들면
    // hasExistingNamespaces() 호출이 "database connection is not open"으로 실패한다.
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
    });
    await dataSource.initialize();
    backupRepository = new BackupRepository(dataSource);

    const restoreJob = new RestoreJob(
      storage,
      backupRepository,
      new SqliteDumpTool(makeConfig(sqliteConfig())),
      makeConfig({
        STORIX_RESTORE_SOURCE_DIR: backupResult.backupDir,
        STORIX_RESTORE_FORCE: 'false',
      }),
    );
    const restoreResult = await restoreJob.run();

    expect(restoreResult.restoredObjectCount).toBeGreaterThanOrEqual(1);
    const restoredContent = await storage.get(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of restoredContent) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true);

    const restoredNamespaceRepo = dataSource.getRepository(NamespaceEntity);
    await expect(
      restoredNamespaceRepo.findOneBy({ name: 'sqlite-backup-fixture-ns' }),
    ).resolves.not.toBeNull();
  });

  it('같은 버킷의 Storix prefix 밖 object는 백업에 들어가지 않고 force 복구 뒤에도 남는다', async () => {
    const storageKey = `blobs/cd/${randomUUID()}`;
    await storage.put(storageKey, Readable.from(Buffer.from('prefix-scope-blob')));
    // 디렉터리 marker와 같은 이름의 하위 object는 prefix 없이 순회하면 백업을 실패시킨다.
    await storage.put('shared-logs/', Readable.from(Buffer.alloc(0)));
    await storage.put('shared-logs/app.log', Readable.from(Buffer.from('foreign-log')));

    const backupResult = await new BackupJob(
      storage,
      backupRepository,
      new SqliteDumpTool(makeConfig(sqliteConfig())),
      makeConfig({ STORIX_BACKUP_DIR: backupRootDir }),
    ).run();

    await expect(fs.access(path.join(backupResult.backupDir, 'blobs', 'shared-logs'))).rejects.toThrow();

    // 백업에 없는 Storix key는 force 복구가 지우고, 다른 시스템 object는 남아야 한다.
    const strayKey = `blobs/ef/${randomUUID()}`;
    await storage.put(strayKey, Readable.from(Buffer.from('stray-not-in-backup')));

    await dataSource.destroy();
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
    });
    await dataSource.initialize();
    backupRepository = new BackupRepository(dataSource);

    await new RestoreJob(
      storage,
      backupRepository,
      new SqliteDumpTool(makeConfig(sqliteConfig())),
      makeConfig({
        STORIX_RESTORE_SOURCE_DIR: backupResult.backupDir,
        STORIX_RESTORE_FORCE: 'true',
      }),
    ).run();

    await expect(storage.get(strayKey)).rejects.toThrow();
    await expect(storage.get(storageKey)).resolves.toBeDefined();
    await expect(storage.get('shared-logs/app.log')).resolves.toBeDefined();
    await expect(storage.get('shared-logs/')).resolves.toBeDefined();
  });
});
