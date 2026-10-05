import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ConfigService } from '@nestjs/config';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm';
import { BackupJob } from '../../src/jobs/backup.job.js';
import { PgDumpCliTool } from '../../src/jobs/pg-dump-cli.tool.js';
import { RestoreJob } from '../../src/jobs/restore.job.js';
import { RestoreTargetNotEmptyError } from '../../src/jobs/restore.errors.js';
import { BackupRepository } from '../../src/persistence/backup.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';

describe('RestoreJob 통합', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let s3Container: StartedS3Container;
  let dataSource: DataSource;
  let backupRepository: BackupRepository;
  let storage: S3BlobStorage;
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
      STORIX_DB_HOST: pgContainer.getHost(),
      STORIX_DB_PORT: String(pgContainer.getPort()),
      STORIX_DB_USERNAME: pgContainer.getUsername(),
      STORIX_DB_PASSWORD: pgContainer.getPassword(),
      STORIX_DB_NAME: pgContainer.getDatabase(),
    };
  }

  async function wipeBucket(): Promise<void> {
    for await (const item of storage.list()) {
      await storage.delete(item.key);
    }
  }

  beforeAll(async () => {
    [pgContainer, s3Container] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      startS3Container(),
    ]);

    dataSource = new DataSource({
      type: 'postgres',
      url: pgContainer.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    backupRepository = new BackupRepository(dataSource);

    const client = createTestS3Client(s3Container);
    await createTestBucket(client, bucket);
    storage = new S3BlobStorage(client, bucket, null);

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
      new PgDumpCliTool(makeConfig({ ...baseConfigValues(), STORIX_BACKUP_DIR: backupRootDir })),
      makeConfig({ ...baseConfigValues(), STORIX_BACKUP_DIR: backupRootDir }),
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
    await Promise.all([pgContainer.stop(), s3Container.stop()]);
    await fs.rm(backupRootDir, { recursive: true, force: true });
  });

  it('빈 대상에 복구하면 백업된 namespace와 스토리지 object가 그대로 복원된다', async () => {
    const job = new RestoreJob(
      storage,
      backupRepository,
      new PgDumpCliTool(
        makeConfig({
          ...baseConfigValues(),
          STORIX_RESTORE_SOURCE_DIR: backupDir,
          STORIX_RESTORE_FORCE: 'false',
        }),
      ),
      makeConfig({
        ...baseConfigValues(),
        STORIX_RESTORE_SOURCE_DIR: backupDir,
        STORIX_RESTORE_FORCE: 'false',
      }),
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
      new PgDumpCliTool(
        makeConfig({
          ...baseConfigValues(),
          STORIX_RESTORE_SOURCE_DIR: backupDir,
          STORIX_RESTORE_FORCE: 'false',
        }),
      ),
      makeConfig({
        ...baseConfigValues(),
        STORIX_RESTORE_SOURCE_DIR: backupDir,
        STORIX_RESTORE_FORCE: 'false',
      }),
    );

    await expect(job.run()).rejects.toThrow(RestoreTargetNotEmptyError);
    await expect(namespaceRepo.findOneBy({ name: 'existing-live-ns' })).resolves.not.toBeNull();
  });

  it('STORIX_RESTORE_FORCE=true면 기존 데이터를 지우고 백업 시점 상태로 덮어쓴다', async () => {
    // 백업에는 없는 object(stray)를 미리 심어 둔다. clearExistingObjects()가
    // 실제로 실행돼 "기존 object를 전부 지운다"는 보장이 지켜지는지 이 key의
    // 생존 여부로 검증한다 — put()이 같은 key를 덮어쓰는 것만으로는 이 보장을
    // 검증할 수 없기 때문에 백업에 없는 key가 필요하다.
    const strayStorageKey = `blobs/ab/${randomUUID()}`;
    await storage.put(strayStorageKey, Readable.from(Buffer.from('stray-object-not-in-backup')));

    const job = new RestoreJob(
      storage,
      backupRepository,
      new PgDumpCliTool(
        makeConfig({
          ...baseConfigValues(),
          STORIX_RESTORE_SOURCE_DIR: backupDir,
          STORIX_RESTORE_FORCE: 'true',
        }),
      ),
      makeConfig({
        ...baseConfigValues(),
        STORIX_RESTORE_SOURCE_DIR: backupDir,
        STORIX_RESTORE_FORCE: 'true',
      }),
    );

    await job.run();

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await expect(namespaceRepo.findOneBy({ name: 'existing-live-ns' })).resolves.toBeNull();
    await expect(namespaceRepo.findOneBy({ name: 'restore-fixture-ns' })).resolves.not.toBeNull();

    await expect(storage.get(strayStorageKey)).rejects.toThrow();
    const restoredContent = await storage.get(seededStorageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of restoredContent) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).equals(seededContent)).toBe(true);
  });

  it('object가 0건인 백업을 복구해도 ENOENT 없이 성공하고 restoredObjectCount는 0이다', async () => {
    // BackupJob.mirrorObjectsToLocalDir는 storage.list() 루프 본문 안에서만
    // mkdir을 호출하므로, 백업 시점에 스토리지 object가 0건이면 <backupDir>/blobs
    // 디렉터리 자체가 생성되지 않는다. 이 케이스를 그대로 재현해 RestoreJob이
    // fs.readdir(ENOENT)로 죽지 않고 0건으로 정상 종료하는지 검증한다.
    await dataSource.query('TRUNCATE namespace CASCADE');
    await wipeBucket();

    const emptyBackupRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-test-empty-'));
    const backupJob = new BackupJob(
      storage,
      backupRepository,
      new PgDumpCliTool(makeConfig({ ...baseConfigValues(), STORIX_BACKUP_DIR: emptyBackupRootDir })),
      makeConfig({ ...baseConfigValues(), STORIX_BACKUP_DIR: emptyBackupRootDir }),
    );
    const emptyBackupResult = await backupJob.run();
    expect(emptyBackupResult.copiedObjectCount).toBe(0);
    await expect(fs.access(path.join(emptyBackupResult.backupDir, 'blobs'))).rejects.toThrow();

    // 복구 대상도 다시 완전히 비운 상태로 되돌린다(이 백업 자체가 namespace
    // 0건짜리이므로, 복구 대상 상태는 이 검증과 무관하다).
    await dataSource.query('TRUNCATE namespace CASCADE');
    await wipeBucket();

    const job = new RestoreJob(
      storage,
      backupRepository,
      new PgDumpCliTool(
        makeConfig({
          ...baseConfigValues(),
          STORIX_RESTORE_SOURCE_DIR: emptyBackupResult.backupDir,
          STORIX_RESTORE_FORCE: 'false',
        }),
      ),
      makeConfig({
        ...baseConfigValues(),
        STORIX_RESTORE_SOURCE_DIR: emptyBackupResult.backupDir,
        STORIX_RESTORE_FORCE: 'false',
      }),
    );

    await expect(job.run()).resolves.toEqual(expect.objectContaining({ restoredObjectCount: 0 }));

    await fs.rm(emptyBackupRootDir, { recursive: true, force: true });
  });

  it('STORIX_RESTORE_SOURCE_DIR에 postgres.dump가 없으면 force여도 스토리지 object를 지우기 전에 실패한다', async () => {
    // 경로 오타로 force 복구를 돌리는 상황. clearExistingObjects()가 먼저 돌면
    // 버킷만 비워지고 pg_restore는 실패해, 복구 전보다 나쁜 상태로 끝난다.
    await dataSource.query('TRUNCATE namespace CASCADE');
    await wipeBucket();

    const liveStorageKey = `blobs/ab/${randomUUID()}`;
    const liveContent = Buffer.from('live-object-must-survive-a-bad-restore');
    await storage.put(liveStorageKey, Readable.from(liveContent));

    const missingSourceDir = path.join(backupRootDir, 'does-not-exist-2026-01-01T00-00-00-000Z');
    const job = new RestoreJob(
      storage,
      backupRepository,
      new PgDumpCliTool(
        makeConfig({
          ...baseConfigValues(),
          STORIX_RESTORE_SOURCE_DIR: missingSourceDir,
          STORIX_RESTORE_FORCE: 'true',
        }),
      ),
      makeConfig({
        ...baseConfigValues(),
        STORIX_RESTORE_SOURCE_DIR: missingSourceDir,
        STORIX_RESTORE_FORCE: 'true',
      }),
    );

    await expect(job.run()).rejects.toThrow('ENOENT');

    const survived = await storage.get(liveStorageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of survived) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).equals(liveContent)).toBe(true);

    await wipeBucket();
  });

  it('STORIX_RESTORE_SOURCE_DIR가 빈 문자열이면 생성 시점에 거부한다', async () => {
    // docker-compose는 `${STORIX_RESTORE_SOURCE_DIR:-}`로 넘기므로 미설정 시 빈
    // 문자열이 도착하고, ConfigService.getOrThrow는 빈 문자열을 통과시킨다.
    expect(
      () =>
        new RestoreJob(
          storage,
          backupRepository,
          new PgDumpCliTool(
            makeConfig({
              ...baseConfigValues(),
              STORIX_RESTORE_SOURCE_DIR: '',
              STORIX_RESTORE_FORCE: 'false',
            }),
          ),
          makeConfig({ ...baseConfigValues(), STORIX_RESTORE_SOURCE_DIR: '', STORIX_RESTORE_FORCE: 'false' }),
        ),
    ).toThrow('STORIX_RESTORE_SOURCE_DIR가 비어 있음');
  });

  describe('다른 버전·다른 사용자 대상 복구', () => {
    // 백업 이후 버전에서 추가된 migration을 흉내 낸다. 실제 migration처럼 IF NOT EXISTS가 없다.
    class AddFutureTable9999999999999 implements MigrationInterface {
      name = 'AddFutureTable9999999999999';
      async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE TABLE "future_table" ("id" integer PRIMARY KEY)');
      }
      async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE "future_table"');
      }
    }

    function makeRestoreJob(
      values: Record<string, string>,
      repository: BackupRepository = backupRepository,
    ): RestoreJob {
      return new RestoreJob(storage, repository, new PgDumpCliTool(makeConfig(values)), makeConfig(values));
    }

    it('백업 이후 migration이 만든 테이블이 있어도 복구 뒤 migration을 다시 적용할 수 있다', async () => {
      const futureDataSource = new DataSource({
        type: 'postgres',
        url: pgContainer.getConnectionUri(),
        synchronize: false,
        migrations: [...ALL_MIGRATIONS, AddFutureTable9999999999999],
      });
      await futureDataSource.initialize();
      try {
        await futureDataSource.runMigrations();

        await makeRestoreJob({
          ...baseConfigValues(),
          STORIX_RESTORE_SOURCE_DIR: backupDir,
          STORIX_RESTORE_FORCE: 'false',
        }).run();

        // 백업에 없는 테이블이 남아 있으면 이 단계가 relation already exists로 실패한다.
        const applied = await futureDataSource.runMigrations();
        expect(applied.map((migration) => migration.name)).toEqual(['AddFutureTable9999999999999']);
        expect(
          await dataSource.getRepository(NamespaceEntity).findOneBy({ name: 'restore-fixture-ns' }),
        ).not.toBeNull();
      } finally {
        await futureDataSource.query('DROP TABLE IF EXISTS "future_table"');
        await futureDataSource.query(`DELETE FROM "migrations" WHERE "name" = 'AddFutureTable9999999999999'`);
        await futureDataSource.destroy();
        await dataSource.query('TRUNCATE namespace CASCADE');
        await wipeBucket();
      }
    });

    it('복구 대상 DB 사용자가 백업을 만든 사용자와 달라도 복구된다', async () => {
      const otherUser = 'restore_other_owner';
      const otherPassword = 'restore-other-password';
      const otherDatabase = 'restore_other_db';
      await dataSource.query(`CREATE ROLE ${otherUser} LOGIN PASSWORD '${otherPassword}'`);
      await dataSource.query(`CREATE DATABASE ${otherDatabase} OWNER ${otherUser}`);
      const otherValues = {
        ...baseConfigValues(),
        STORIX_DB_USERNAME: otherUser,
        STORIX_DB_PASSWORD: otherPassword,
        STORIX_DB_NAME: otherDatabase,
        STORIX_RESTORE_SOURCE_DIR: backupDir,
        STORIX_RESTORE_FORCE: 'false',
      };
      const otherDataSource = new DataSource({
        type: 'postgres',
        host: pgContainer.getHost(),
        port: pgContainer.getPort(),
        username: otherUser,
        password: otherPassword,
        database: otherDatabase,
        synchronize: false,
        entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
        migrations: ALL_MIGRATIONS,
      });
      await otherDataSource.initialize();
      try {
        await otherDataSource.runMigrations();

        await makeRestoreJob(otherValues, new BackupRepository(otherDataSource)).run();

        expect(
          await otherDataSource.getRepository(NamespaceEntity).findOneBy({ name: 'restore-fixture-ns' }),
        ).not.toBeNull();
        const owners = (await otherDataSource.query(
          `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
        )) as Array<{ tableowner: string }>;
        expect(owners.map((row) => row.tableowner)).toEqual([otherUser]);
      } finally {
        await otherDataSource.destroy();
        await dataSource.query(`DROP DATABASE ${otherDatabase}`);
        await dataSource.query(`DROP ROLE ${otherUser}`);
        await wipeBucket();
      }
    });

    it('DB 복구가 중간에 실패해도 force 없이 같은 백업으로 다시 실행할 수 있다', async () => {
      // 기존 데이터를 force로 덮어쓰다가 dump가 잘려 pg_restore가 실패하는 상황
      const namespaceRepo = dataSource.getRepository(NamespaceEntity);
      await namespaceRepo.save(namespaceRepo.create({ name: 'restore-live-ns', encryptionPolicy: 'NONE' }));
      const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-broken-'));
      try {
        const dump = await fs.readFile(path.join(backupDir, 'postgres.dump'));
        await fs.writeFile(
          path.join(brokenDir, 'postgres.dump'),
          dump.subarray(0, Math.floor(dump.length * 0.7)),
        );

        await expect(
          makeRestoreJob({
            ...baseConfigValues(),
            STORIX_RESTORE_SOURCE_DIR: brokenDir,
            STORIX_RESTORE_FORCE: 'true',
          }).run(),
        ).rejects.toThrow('pg_restore');

        await makeRestoreJob({
          ...baseConfigValues(),
          STORIX_RESTORE_SOURCE_DIR: backupDir,
          STORIX_RESTORE_FORCE: 'false',
        }).run();

        const names = (await namespaceRepo.find()).map((namespace) => namespace.name);
        expect(names).toEqual(['restore-fixture-ns']);
      } finally {
        await fs.rm(brokenDir, { recursive: true, force: true });
        await dataSource.query('TRUNCATE namespace CASCADE');
        await wipeBucket();
      }
    });
  });
});
