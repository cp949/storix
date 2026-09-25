import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsMutationReceiptEntity } from './entities/vfs-mutation-receipt.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { VfsMutationReceiptRepository } from './vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { runVfsMutationReceiptSharedTests } from './vfs-mutation-receipt.repository.shared-tests.js';

describe('VFS mutation receipt (SQLite)', () => {
  let dataSource: DataSource;
  let receiptRepository: VfsMutationReceiptRepository;
  let nodeRepository: VfsNodeRepository;
  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
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
    );
  });
  afterAll(async () => {
    await dataSource.destroy();
  });
  runVfsMutationReceiptSharedTests(() => ({ dataSource, receiptRepository, nodeRepository }));
});
