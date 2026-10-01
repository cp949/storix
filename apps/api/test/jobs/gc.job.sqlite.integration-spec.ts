import { VfsSnapshotEntryEntity } from '../../src/persistence/entities/vfs-snapshot-entry.entity.js';
import { VfsSnapshotEntity } from '../../src/persistence/entities/vfs-snapshot.entity.js';
import { VfsChangeEventEntity } from '../../src/persistence/entities/vfs-change-event.entity.js';
import { VfsUploadStagingCleanupEntity } from '../../src/persistence/entities/vfs-upload-staging-cleanup.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { VfsUploadPartEntity } from '../../src/persistence/entities/vfs-upload-part.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { NamespaceDeletionReceiptEntity } from '../../src/persistence/entities/namespace-deletion-receipt.entity.js';
import { NamespaceDeletionEntity } from '../../src/persistence/entities/namespace-deletion.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { runNamespaceDeletionCleanupTests } from './namespace-deletion.cleanup.shared-tests.js';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import { DataSource } from 'typeorm';
import { runGcJobSharedTests } from './gc.job.shared-tests.js';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsFileExpiryRepository } from '../../src/persistence/vfs-file-expiry.repository.js';
import { VfsTrashRetentionRepository } from '../../src/persistence/vfs-trash-retention.repository.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';

// STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행에서만 돈다(blob.repository.sqlite.integration-spec.ts와
// 동일 관례) — 그 외 실행에서는 jest.integration.config.cjs의 testPathIgnorePatterns가 제외한다.
// S3 스토리지(VersityGW)는 Postgres 버전과 동일하게 testcontainers로 띄운다 — object storage는 드라이버와 무관.
describe('GcJob 통합 (SQLite)', () => {
  let s3Container: StartedS3Container;
  let dataSource: DataSource;
  let blobRepository: BlobRepository;
  let storage: S3BlobStorage;
  let namespaceId: string;
  let nodeRepository: VfsNodeRepository;
  let trashRetention: VfsTrashRetentionRepository;
  let fileExpiry: VfsFileExpiryRepository;
  const bucket = 'storix-gc-sqlite-test';

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error(
        'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 엔티티의 bytea/timestamptz 대체 상수가 postgres 값으로 고정돼 의미가 없다',
      );
    }
    s3Container = await startS3Container();

    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [
        VfsSnapshotEntryEntity,
        VfsSnapshotEntity,
        VfsChangeEventEntity,
        VfsUploadStagingCleanupEntity,
        VfsUploadUsageEntity,
        VfsUploadPartEntity,
        VfsUploadSessionEntity,
        NamespaceDeletionReceiptEntity,
        NamespaceDeletionEntity,
        VfsChangeFeedStateEntity,
        NamespaceEntity,
        VfsNodeEntity,
        BlobEntity,
        IdempotencyKeyEntity,
        VfsTrashEntity,
        VfsTrashEntryEntity,
      ],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    installSqliteGate(dataSource);
    blobRepository = new BlobRepository(dataSource);
    nodeRepository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      blobRepository,
      { get: () => undefined } as never,
    );
    trashRetention = new VfsTrashRetentionRepository(dataSource, nodeRepository);
    fileExpiry = new VfsFileExpiryRepository(dataSource, nodeRepository);

    const client = createTestS3Client(s3Container);
    await createTestBucket(client, bucket);
    storage = new S3BlobStorage(client, bucket, null);

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'gc-job-owner' }));
    namespaceId = namespace.id;
  }, 180000);

  afterAll(async () => {
    await dataSource.destroy();
    await s3Container.stop();
  });

  runGcJobSharedTests(() => ({
    dataSource,
    storage,
    blobRepository,
    namespaceId,
    nodeRepository,
    trashRetention,
    fileExpiry,
    setZeroSinceSecondsAgo: (blobId, secondsAgo) =>
      dataSource.query(`UPDATE blob SET zero_since = datetime('now', ? || ' seconds') WHERE id = ?`, [
        `-${secondsAgo}`,
        blobId,
      ]),
  }));
  runNamespaceDeletionCleanupTests(() => ({
    dataSource,
    storage,
    blobRepository,
    namespaceId,
    nodeRepository,
    trashRetention,
    fileExpiry,
    setZeroSinceSecondsAgo: (blobId, secondsAgo) =>
      dataSource.query(`UPDATE blob SET zero_since = datetime('now', ? || ' seconds') WHERE id = ?`, [
        `-${secondsAgo}`,
        blobId,
      ]),
  }));
});
