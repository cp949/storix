import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import type { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { DataSource } from 'typeorm';
import { BackupJob } from './backup.job.js';
import { RestoreJob } from './restore.job.js';
import { SqliteDumpTool } from './sqlite-dump.tool.js';
import { BackupRepository } from '../persistence/backup.repository.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { MinioBlobStorage } from '../storage/minio-blob-storage.js';

// SQLite는 파일 하나가 곧 DB이므로, BackupJob/RestoreJob이 열어 둔 DataSource와
// SqliteDumpTool이 파일 경로로 직접 여는 better-sqlite3 연결이 같은 파일을
// 가리키게 한다(단일 프로세스 배포 모델과 일치). MinIO는 Postgres 테스트와
// 동일하게 testcontainers로 띄운다 — object storage는 드라이버와 무관.
describe('Backup/Restore SQLite 통합', () => {
  let minioContainer: StartedMinioContainer;
  let dbDir: string;
  let dbPath: string;
  let dataSource: DataSource;
  let backupRepository: BackupRepository;
  let storage: MinioBlobStorage;
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
    minioContainer = await new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start();

    dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-backup-restore-sqlite-'));
    dbPath = path.join(dbDir, 'storix.sqlite');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS.slice(0, 5),
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    backupRepository = new BackupRepository(dataSource);

    const client = new Client({
      endPoint: minioContainer.getHost(),
      port: minioContainer.getPort(),
      useSSL: false,
      accessKey: minioContainer.getUsername(),
      secretKey: minioContainer.getPassword(),
    });
    await client.makeBucket(bucket);
    storage = new MinioBlobStorage(client, bucket, null);

    backupRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-backup-restore-sqlite-out-'));
  }, 180000);

  afterAll(async () => {
    await dataSource.destroy();
    await minioContainer.stop();
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(backupRootDir, { recursive: true, force: true });
  });

  it('VACUUM INTO로 백업하고 파일 복사로 복구하면 namespace와 MinIO object가 그대로 복원된다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await namespaceRepo.save(namespaceRepo.create({ name: 'sqlite-backup-fixture-ns', encryptionPolicy: 'NONE' }));

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
    await expect(restoredNamespaceRepo.findOneBy({ name: 'sqlite-backup-fixture-ns' })).resolves.not.toBeNull();
  });
});
