import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { runBlobRepositorySharedTests } from './blob.repository.shared-tests.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from './migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from './migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from './migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from './migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from './migrations/1788637362016-InitSchema.js';

// STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행에서만 돈다(migrations.sqlite.integration-spec.ts와
// 동일 관례) — 그 외 실행에서는 jest.integration.config.cjs의 testPathIgnorePatterns가 제외한다.
describe('BlobRepository (SQLite)', () => {
  let dataSource: DataSource;
  let repository: BlobRepository;
  let namespaceId: string;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error(
        'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 엔티티의 bytea/timestamptz 대체 상수가 postgres 값으로 고정돼 의미가 없다',
      );
    }
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
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
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  runBlobRepositorySharedTests(() => ({
    dataSource,
    repository,
    namespaceId,
    setZeroSinceSecondsAgo: (blobId, secondsAgo) =>
      dataSource.query(`UPDATE blob SET zero_since = datetime('now', ? || ' seconds') WHERE id = ?`, [
        `-${secondsAgo}`,
        blobId,
      ]),
  }));
});
