import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from './migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from './migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from './migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from './migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from './migrations/1788637362016-InitSchema.js';

describe('BlobRepository', () => {
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
    repository = new BlobRepository(dataSource);

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'blob-repo-owner' }));
    namespaceId = namespace.id;
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  async function createBlob(referenceCount: number): Promise<BlobEntity> {
    const blobRepo = dataSource.getRepository(BlobEntity);
    return blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey: `blobs/ab/${randomUUID()}`,
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'e'.repeat(64),
        referenceCount,
      }),
    );
  }

  describe('decrementReferenceCount', () => {
    it('0보다 크게 감소하면 zero_since를 채우지 않는다', async () => {
      const blob = await createBlob(2);

      await dataSource.transaction((manager) => repository.decrementReferenceCount(manager, blob.id, 1));

      const updated = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id });
      expect(updated.referenceCount).toBe(1);
      expect(updated.zeroSince).toBeNull();
    });

    it('0이 되는 순간 zero_since를 기록한다', async () => {
      const blob = await createBlob(1);

      await dataSource.transaction((manager) => repository.decrementReferenceCount(manager, blob.id, 1));

      const updated = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id });
      expect(updated.referenceCount).toBe(0);
      expect(updated.zeroSince).toBeInstanceOf(Date);
    });
  });

  describe('findOrphanBlobs', () => {
    it('grace period가 지난 reference_count=0 blob만 반환한다', async () => {
      const stillReferenced = await createBlob(1);
      const tooRecent = await createBlob(0);
      const eligible = await createBlob(0);

      await dataSource.query('UPDATE blob SET zero_since = now() WHERE id = $1', [tooRecent.id]);
      await dataSource.query("UPDATE blob SET zero_since = now() - interval '1 hour' WHERE id = $1", [
        eligible.id,
      ]);

      const cutoff = new Date(Date.now() - 60_000);
      const orphans = await repository.findOrphanBlobs(cutoff);
      const orphanIds = orphans.map((row) => row.id);

      expect(orphanIds).toContain(eligible.id);
      expect(orphanIds).not.toContain(tooRecent.id);
      expect(orphanIds).not.toContain(stillReferenced.id);
    });
  });

  describe('deleteBlobRows', () => {
    it('지정한 id의 row만 삭제한다', async () => {
      const target = await createBlob(0);
      const untouched = await createBlob(0);

      await repository.deleteBlobRows([target.id]);

      const blobRepo = dataSource.getRepository(BlobEntity);
      expect(await blobRepo.findOneBy({ id: target.id })).toBeNull();
      expect(await blobRepo.findOneBy({ id: untouched.id })).not.toBeNull();
    });

    it('빈 배열을 넘기면 아무것도 삭제하지 않는다', async () => {
      const untouched = await createBlob(0);

      await repository.deleteBlobRows([]);

      expect(await dataSource.getRepository(BlobEntity).findOneBy({ id: untouched.id })).not.toBeNull();
    });
  });

  describe('findAllStorageKeys', () => {
    it('참조 여부와 무관하게 모든 blob의 storage_key를 반환한다', async () => {
      const referenced = await createBlob(1);
      const orphaned = await createBlob(0);

      const keys = await repository.findAllStorageKeys();

      expect(keys.has(referenced.storageKey)).toBe(true);
      expect(keys.has(orphaned.storageKey)).toBe(true);
    });
  });
});
