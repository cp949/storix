import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { runBlobRepositorySharedTests } from './blob.repository.shared-tests.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';

describe('BlobRepository (Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: BlobRepository;
  let namespaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS.slice(0, 5),
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    repository = new BlobRepository(dataSource);

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'blob-repo-owner' }));
    namespaceId = namespace.id;
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runBlobRepositorySharedTests(() => ({
    dataSource,
    repository,
    namespaceId,
    setZeroSinceSecondsAgo: (blobId, secondsAgo) =>
      dataSource.query(`UPDATE blob SET zero_since = now() - ($2 * interval '1 second') WHERE id = $1`, [
        blobId,
        secondsAgo,
      ]),
  }));
});
