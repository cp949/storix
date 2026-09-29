import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';

describe('GcJob 통합', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let s3Container: StartedS3Container;
  let dataSource: DataSource;
  let blobRepository: BlobRepository;
  let storage: S3BlobStorage;
  let namespaceId: string;
  let nodeRepository: VfsNodeRepository;
  let trashRetention: VfsTrashRetentionRepository;
  let fileExpiry: VfsFileExpiryRepository;
  const bucket = 'storix-gc-test';

  beforeAll(async () => {
    [pgContainer, s3Container] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      startS3Container(),
    ]);

    dataSource = new DataSource({
      type: 'postgres',
      url: pgContainer.getConnectionUri(),
      synchronize: false,
      entities: [
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
    await Promise.all([pgContainer.stop(), s3Container.stop()]);
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
      dataSource.query(`UPDATE blob SET zero_since = now() - ($1 || ' seconds')::interval WHERE id = $2`, [
        secondsAgo,
        blobId,
      ]),
  }));
});
