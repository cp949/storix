import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';

// 이 파일은 vfs-node.repository.integration-spec.ts(Postgres, 1153줄) 전체를
// 두 드라이버로 이중화하지 않는다 — Plan B에서 고친 raw query 3건
// (findRecursive, removeNode/copyNode의 subtree 조회)이 실제로 SQLite에서
// 동작한다는 최소 증거만 확인하는 포커스드 스모크다(전체 패리티가 목표가
// 아님). STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행에서만 돈다.
describe('VfsNodeRepository SQLite 스모크', () => {
  let dataSource: DataSource;
  let repository: VfsNodeRepository;
  let provisioning: NamespaceProvisioningRepository;

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
      migrations: ALL_MIGRATIONS.slice(0, 5),
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
    provisioning = new NamespaceProvisioningRepository(dataSource);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function createNamespace(name: string) {
    return provisioning.createWithRoot(name);
  }

  async function createFile(namespaceId: string, parentId: string, name: string) {
    const blobRepo = dataSource.getRepository(BlobEntity);
    const nodeRepo = dataSource.getRepository(VfsNodeEntity);
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey: `blobs/00/${randomUUID()}`,
        size: '0',
        mimeType: 'application/octet-stream',
        sha256: '0'.repeat(64),
        referenceCount: 1,
      }),
    );
    return nodeRepo.save(
      nodeRepo.create({
        namespaceId,
        parentId,
        type: 'FILE',
        name,
        blobId: blob.id,
        size: '0',
        mimeType: 'application/octet-stream',
      }),
    );
  }

  describe('findRecursive', () => {
    async function buildTree(namespace: { id: string }, root: { id: string }) {
      const a = await repository.ensureDirectory(namespace.id, root.id, ['a'], false);
      await repository.ensureDirectory(namespace.id, a.node.id, ['b'], false);
      await createFile(namespace.id, a.node.id, 'report.pdf');
      await createFile(namespace.id, root.id, 'readme.md');
      return a.node;
    }

    it('시작 경로 하위를 재귀적으로 모두 반환한다', async () => {
      const namespace = await createNamespace('find-all-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await repository.findRecursive(namespace.id, root!.id, {}, null, 100);

      expect(items.map((i) => i.name).sort()).toEqual(['a', 'b', 'readme.md', 'report.pdf'].sort());
    });

    it('name 필터에 LIKE 특수문자가 있어도 리터럴로 취급하고, 대소문자를 구분한다', async () => {
      const namespace = await createNamespace('find-escape-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['100%_done'], false);
      await repository.ensureDirectory(namespace.id, root!.id, ['100XXdone'], false);

      const items = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'contains', value: '%_' } },
        null,
        100,
      );

      expect(items.map((i) => i.name)).toEqual(['100%_done']);

      // PRAGMA case_sensitive_like=ON을 확인하는 회귀 테스트 — SQLite 기본값(대소문자
      // 무시)이었다면 'xx'(소문자) contains 검색이 '100XXdone'(대문자)에도 걸린다.
      const caseSensitive = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'contains', value: 'xx' } },
        null,
        100,
      );
      expect(caseSensitive.map((i) => i.name)).toEqual([]);
    });

    it('cursor 이후의 항목만 반환한다(row value 비교가 SQLite에서도 동작)', async () => {
      const namespace = await createNamespace('find-cursor-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const first = await repository.findRecursive(namespace.id, root!.id, {}, null, 1);
      const next = await repository.findRecursive(
        namespace.id,
        root!.id,
        {},
        { name: first[0].name, id: first[0].id },
        100,
      );

      expect(next.length).toBe(3);
      expect(next.some((i) => i.name === first[0].name && i.id === first[0].id)).toBe(false);
    });

    it('createdAt/updatedAt을 Date 인스턴스로 반환한다', async () => {
      const namespace = await createNamespace('find-dates-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await repository.findRecursive(namespace.id, root!.id, {}, null, 100);

      for (const item of items) {
        expect(item.createdAt).toBeInstanceOf(Date);
        expect(item.updatedAt).toBeInstanceOf(Date);
        expect(Number.isNaN(item.createdAt.getTime())).toBe(false);
      }
    });
  });

  describe('removeNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('recursive=true면 하위 트리를 모두 삭제하고 각 file의 Blob 참조를 줄인다', async () => {
      const namespace = await createNamespace('rm-recursive-ns');
      const root = await repository.getRoot(namespace.id);
      const a = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      const c = await repository.ensureDirectory(namespace.id, root!.id, ['a', 'c'], false);
      const fileB = await createFile(namespace.id, a.node.id, 'b.txt');
      const fileD = await createFile(namespace.id, c.node.id, 'd.txt');

      await repository.removeNode(namespace.id, root!.id, ['a'], true, UNLIMITED);

      expect(await repository.resolvePath(namespace.id, root!.id, ['a'])).toBeNull();
      const blobRepo = dataSource.getRepository(BlobEntity);
      const blobB = await blobRepo.findOneByOrFail({ id: fileB.blobId as string });
      const blobD = await blobRepo.findOneByOrFail({ id: fileD.blobId as string });
      expect(blobB.referenceCount).toBe(0);
      expect(blobD.referenceCount).toBe(0);
    });
  });

  describe('copyNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('DIRECTORY를 재귀 복사하면 subtree 전체가 새 id로 생성되고 Blob 참조가 늘어난다', async () => {
      const namespace = await createNamespace('copy-recursive-ns');
      const root = await repository.getRoot(namespace.id);
      const a = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      const file = await createFile(namespace.id, a.node.id, 'x.txt');

      const result = await repository.copyNode(namespace.id, root!.id, ['a'], ['a-copy'], false, UNLIMITED);

      const copiedFile = await repository.resolvePath(namespace.id, root!.id, ['a-copy', 'x.txt']);
      expect(copiedFile).not.toBeNull();
      expect(copiedFile!.id).not.toBe(file.id);
      const blobRepo = dataSource.getRepository(BlobEntity);
      const blob = await blobRepo.findOneByOrFail({ id: file.blobId as string });
      expect(blob.referenceCount).toBe(2);
      expect(result.finalPath).toBe('/a-copy');
    });
  });
});
