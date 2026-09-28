import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'minio';
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
import { MinioBlobStorage } from '../../src/storage/minio-blob-storage.js';

describe('GcJob 통합', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let dataSource: DataSource;
  let blobRepository: BlobRepository;
  let storage: MinioBlobStorage;
  let namespaceId: string;
  let nodeRepository: VfsNodeRepository;
  let trashRetention: VfsTrashRetentionRepository;
  let fileExpiry: VfsFileExpiryRepository;
  const bucket = 'storix-gc-test';

  beforeAll(async () => {
    [pgContainer, minioContainer] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start(),
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

    const client = new Client({
      endPoint: minioContainer.getHost(),
      port: minioContainer.getPort(),
      useSSL: false,
      accessKey: minioContainer.getUsername(),
      secretKey: minioContainer.getPassword(),
    });
    await client.makeBucket(bucket);
    storage = new MinioBlobStorage(client, bucket, null);

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'gc-job-owner' }));
    namespaceId = namespace.id;
  }, 180000);

  afterAll(async () => {
    await dataSource.destroy();
    await Promise.all([pgContainer.stop(), minioContainer.stop()]);
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
