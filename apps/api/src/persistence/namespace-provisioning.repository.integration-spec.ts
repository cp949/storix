import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, IsNull } from 'typeorm';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from './migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from './migrations/1788700000000-AddIdempotencyKey.js';
import { InitSchema1788637362016 } from './migrations/1788637362016-InitSchema.js';
import { NamespaceAlreadyExistsError } from '../namespace/namespace.errors.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';

describe('NamespaceProvisioningRepository', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: NamespaceProvisioningRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: [InitSchema1788637362016, AddIdempotencyKey1788700000000, AddBlobZeroSince1788800000000],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    repository = new NamespaceProvisioningRepository(dataSource);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  it('namespace와 root directory를 하나의 transaction으로 함께 생성한다', async () => {
    const namespace = await repository.createWithRoot('acme');

    const nodeRepo = dataSource.getRepository(VfsNodeEntity);
    const root = await nodeRepo.findOneByOrFail({ namespaceId: namespace.id, parentId: IsNull() });

    expect(root.type).toBe('DIRECTORY');
    expect(root.name).toBe('');
  });

  it('이미 활성화된 name으로 다시 생성하면 NamespaceAlreadyExistsError를 던진다', async () => {
    await repository.createWithRoot('dup-active-ns');

    await expect(repository.createWithRoot('dup-active-ns')).rejects.toThrow(NamespaceAlreadyExistsError);
  });

  it('name 충돌로 실패한 시도는 namespace도 root도 남기지 않는다', async () => {
    await repository.createWithRoot('conflict-once');
    await expect(repository.createWithRoot('conflict-once')).rejects.toThrow(NamespaceAlreadyExistsError);

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const matches = await namespaceRepo.findBy({ name: 'conflict-once' });

    expect(matches).toHaveLength(1);
  });
});
