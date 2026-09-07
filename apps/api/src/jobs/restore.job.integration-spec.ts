import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { DataSource } from 'typeorm';
import { BackupJob } from './backup.job.js';
import { PgDumpCliTool } from './pg-dump-cli.tool.js';
import { RestoreJob } from './restore.job.js';
import { RestoreTargetNotEmptyError } from './restore.errors.js';
import { BackupRepository } from '../persistence/backup.repository.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from '../persistence/migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from '../persistence/migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from '../persistence/migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from '../persistence/migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from '../persistence/migrations/1788637362016-InitSchema.js';
import { MinioBlobStorage } from '../storage/minio-blob-storage.js';

describe('RestoreJob 통합', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let dataSource: DataSource;
  let backupRepository: BackupRepository;
  let storage: MinioBlobStorage;
  let backupRootDir: string;
  let backupDir: string;
  let seededStorageKey: string;
  let seededContent: Buffer;
  const bucket = 'storix-restore-job-test';

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

  function baseConfigValues(): Record<string, string> {
    return {
      DB_HOST: pgContainer.getHost(),
      DB_PORT: String(pgContainer.getPort()),
      DB_USERNAME: pgContainer.getUsername(),
      DB_PASSWORD: pgContainer.getPassword(),
      DB_NAME: pgContainer.getDatabase(),
    };
  }

  async function wipeBucket(): Promise<void> {
    for await (const item of storage.list()) {
      await storage.delete(item.key);
    }
  }

  beforeAll(async () => {
    [pgContainer, minioContainer] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start(),
    ]);

    dataSource = new DataSource({
      type: 'postgres',
      url: pgContainer.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: [
        InitSchema1788637362016,
        AddIdempotencyKey1788700000000,
        AddBlobZeroSince1788800000000,
        AddNamespaceResourceLimits1789000000000,
        AddEncryptionSupport1789100000000,
      ],
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

    backupRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-test-'));

    // fixture: 원본 namespace + blob을 만들고 백업을 한 번 떠서 restore 테스트의
    // 입력으로 쓴다.
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await namespaceRepo.save(namespaceRepo.create({ name: 'restore-fixture-ns', encryptionPolicy: 'NONE' }));
    seededStorageKey = `blobs/ab/${randomUUID()}`;
    seededContent = Buffer.from('restore-job-fixture-content');
    await storage.put(seededStorageKey, Readable.from(seededContent));

    const backupJob = new BackupJob(
      storage,
      backupRepository,
      new PgDumpCliTool(),
      makeConfig({ ...baseConfigValues(), BACKUP_DIR: backupRootDir }),
    );
    const backupResult = await backupJob.run();
    backupDir = backupResult.backupDir;

    // 백업을 뜬 뒤에는 대상을 완전히 비운 상태로 되돌려, 이후 각 테스트가
    // "빈 대상"부터 시작하도록 만든다.
    await dataSource.query('TRUNCATE namespace CASCADE');
    await wipeBucket();
  }, 180000);

  afterAll(async () => {
    await dataSource.destroy();
    await Promise.all([pgContainer.stop(), minioContainer.stop()]);
    await fs.rm(backupRootDir, { recursive: true, force: true });
  });

  it('빈 대상에 복구하면 백업된 namespace와 MinIO object가 그대로 복원된다', async () => {
    const job = new RestoreJob(
      storage,
      backupRepository,
      new PgDumpCliTool(),
      makeConfig({ ...baseConfigValues(), RESTORE_SOURCE_DIR: backupDir, RESTORE_FORCE: 'false' }),
    );

    const result = await job.run();

    expect(result.restoredObjectCount).toBeGreaterThanOrEqual(1);
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await expect(namespaceRepo.findOneBy({ name: 'restore-fixture-ns' })).resolves.not.toBeNull();

    const restoredContent = await storage.get(seededStorageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of restoredContent) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).equals(seededContent)).toBe(true);
  });

  it('대상에 이미 namespace 데이터가 있으면 force 없이는 거부하고 기존 데이터를 건드리지 않는다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await namespaceRepo.save(namespaceRepo.create({ name: 'existing-live-ns', encryptionPolicy: 'NONE' }));

    const job = new RestoreJob(
      storage,
      backupRepository,
      new PgDumpCliTool(),
      makeConfig({ ...baseConfigValues(), RESTORE_SOURCE_DIR: backupDir, RESTORE_FORCE: 'false' }),
    );

    await expect(job.run()).rejects.toThrow(RestoreTargetNotEmptyError);
    await expect(namespaceRepo.findOneBy({ name: 'existing-live-ns' })).resolves.not.toBeNull();
  });

  it('RESTORE_FORCE=true면 기존 데이터를 지우고 백업 시점 상태로 덮어쓴다', async () => {
    const job = new RestoreJob(
      storage,
      backupRepository,
      new PgDumpCliTool(),
      makeConfig({ ...baseConfigValues(), RESTORE_SOURCE_DIR: backupDir, RESTORE_FORCE: 'true' }),
    );

    await job.run();

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await expect(namespaceRepo.findOneBy({ name: 'existing-live-ns' })).resolves.toBeNull();
    await expect(namespaceRepo.findOneBy({ name: 'restore-fixture-ns' })).resolves.not.toBeNull();
  });
});
