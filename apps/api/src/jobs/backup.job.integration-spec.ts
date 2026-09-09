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
import { BackupRepository } from '../persistence/backup.repository.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../persistence/migrations/all-migrations.js';
import { MinioBlobStorage } from '../storage/minio-blob-storage.js';

describe('BackupJob 통합', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let dataSource: DataSource;
  let backupRepository: BackupRepository;
  let storage: MinioBlobStorage;
  let backupRootDir: string;
  const bucket = 'storix-backup-job-test';

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
      STORIX_BACKUP_DIR: backupRootDir,
      STORIX_DB_HOST: pgContainer.getHost(),
      STORIX_DB_PORT: String(pgContainer.getPort()),
      STORIX_DB_USERNAME: pgContainer.getUsername(),
      STORIX_DB_PASSWORD: pgContainer.getPassword(),
      STORIX_DB_NAME: pgContainer.getDatabase(),
    };
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
      migrations: ALL_MIGRATIONS.slice(0, 3),
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

    backupRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-backup-test-'));
  }, 180000);

  afterAll(async () => {
    await dataSource.destroy();
    await Promise.all([pgContainer.stop(), minioContainer.stop()]);
    await fs.rm(backupRootDir, { recursive: true, force: true });
  });

  it('Postgres 스냅샷과 MinIO object를 로컬 디렉터리에 남기고, ENCRYPTED namespace 개수를 센다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await namespaceRepo.save(namespaceRepo.create({ name: 'backup-test-plain', encryptionPolicy: 'NONE' }));
    await namespaceRepo.save(namespaceRepo.create({ name: 'backup-test-enc', encryptionPolicy: 'ENCRYPTED' }));

    const storageKey = `blobs/ab/${randomUUID()}`;
    const content = Buffer.from('backup-job-test-content');
    await storage.put(storageKey, Readable.from(content));

    const job = new BackupJob(
      storage,
      backupRepository,
      new PgDumpCliTool(makeConfig(baseConfigValues())),
      makeConfig(baseConfigValues()),
    );
    const result = await job.run();

    expect(result.encryptedNamespaceCount).toBe(1);
    expect(result.copiedObjectCount).toBeGreaterThanOrEqual(1);

    const dumpStat = await fs.stat(path.join(result.backupDir, 'postgres.dump'));
    expect(dumpStat.size).toBeGreaterThan(0);

    // 성공한 백업은 `.partial` 작업 디렉터리를 남기지 않고 최종 이름으로
    // rename돼 있어야 한다 — 운영자의 보존/회전 스크립트가 완결된 백업만
    // 집어갈 수 있게 하는 표식이다.
    expect(result.backupDir.endsWith('.partial')).toBe(false);
    await expect(fs.access(`${result.backupDir}.partial`)).rejects.toThrow();

    const mirroredContent = await fs.readFile(path.join(result.backupDir, 'minio', storageKey));
    expect(mirroredContent.equals(content)).toBe(true);
  });
});
