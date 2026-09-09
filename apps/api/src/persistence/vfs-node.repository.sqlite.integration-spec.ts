import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { runVfsNodeRepositorySharedTests } from './vfs-node.repository.shared-tests.js';

// STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행에서만 돈다(migrations.sqlite.integration-spec.ts와
// 동일 관례) — 그 외 실행에서는 jest.integration.config.cjs의 testPathIgnorePatterns가 제외한다.
// vfs-node.repository.integration-spec.ts(Postgres)와 같은 본문
// (vfs-node.repository.shared-tests.ts)을 그대로 돌려, findRecursive/removeNode/
// copyNode의 raw SQL 분기가 SQLite에서도 전체 시나리오에 걸쳐 검증되게 한다
// — 예전엔 그 세 메서드만 확인하는 216줄짜리 포커스드 스모크뿐이었다.
describe('VfsNodeRepository (SQLite)', () => {
  let dataSource: DataSource;
  let repository: VfsNodeRepository;

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
      migrations: ALL_MIGRATIONS.slice(0, 3),
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.query('PRAGMA case_sensitive_like = ON');

    repository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
    );
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  runVfsNodeRepositorySharedTests(() => ({ dataSource, repository }));

  // 공유 본문에는 없는 SQLite 전용 회귀 — PRAGMA case_sensitive_like=ON을
  // 빼먹으면(SQLite 기본값은 대소문자 무시) 조용히 깨진다. Postgres는 LIKE가
  // 원래부터 대소문자를 구분해 대응하는 테스트가 없다.
  describe('findRecursive — SQLite PRAGMA case_sensitive_like', () => {
    it('기본값(대소문자 무시)이 아니라 실제로 대소문자를 구분한다', async () => {
      const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot('find-case-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['100xxdone'], false);

      const caseSensitive = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'contains', value: 'XX' } },
        null,
        100,
      );

      expect(caseSensitive.map((i) => i.name)).toEqual([]);
    });
  });
});
