import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BackupRepository } from './backup.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from './migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from './migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from './migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from './migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from './migrations/1788637362016-InitSchema.js';

describe('BackupRepository', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: BackupRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
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
    repository = new BackupRepository(dataSource);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  it('namespace가 하나도 없으면 false를 반환한다', async () => {
    await expect(repository.hasExistingNamespaces()).resolves.toBe(false);
  });

  it('ENCRYPTED namespace 개수를 센다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    await namespaceRepo.save(namespaceRepo.create({ name: 'plain-ns', encryptionPolicy: 'NONE' }));
    await namespaceRepo.save(namespaceRepo.create({ name: 'enc-ns-1', encryptionPolicy: 'ENCRYPTED' }));
    await namespaceRepo.save(namespaceRepo.create({ name: 'enc-ns-2', encryptionPolicy: 'ENCRYPTED' }));

    await expect(repository.countEncryptedNamespaces()).resolves.toBe(2);
    await expect(repository.hasExistingNamespaces()).resolves.toBe(true);
  });
});
