import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { runVfsMutationReceiptSharedTests } from './vfs-mutation-receipt.repository.shared-tests.js';

describe('VFS mutation receipt (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let receiptRepository: VfsMutationReceiptRepository;
  let nodeRepository: VfsNodeRepository;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, VfsMutationReceiptEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    receiptRepository = new VfsMutationReceiptRepository(dataSource);
    nodeRepository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
      new ConfigService(),
    );
  }, 120000);
  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });
  runVfsMutationReceiptSharedTests(() => ({ dataSource, receiptRepository, nodeRepository }));
});
