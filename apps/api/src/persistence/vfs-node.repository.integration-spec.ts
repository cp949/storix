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
import { InitSchema1788637362016 } from './migrations/1788637362016-InitSchema.js';
import { NamespaceProvisioningRepository } from './namespace-provisioning.repository.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import {
  VfsAlreadyExistsError,
  VfsCopyLimitExceededError,
  VfsDeleteLimitExceededError,
  VfsDirectoryNotEmptyError,
  VfsInvalidOperationError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsVersionConflictError,
} from '../vfs/vfs.errors.js';

describe('VfsNodeRepository', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: VfsNodeRepository;
  let provisioning: NamespaceProvisioningRepository;

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
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    repository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
    );
    provisioning = new NamespaceProvisioningRepository(dataSource);
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
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

  describe('getRoot', () => {
    it('존재하는 namespace의 root node를 반환한다', async () => {
      const namespace = await createNamespace('get-root-ns');

      const root = await repository.getRoot(namespace.id);

      expect(root).toMatchObject({ name: '', type: 'DIRECTORY' });
    });

    it('존재하지 않는 namespace면 null을 반환한다', async () => {
      const root = await repository.getRoot(randomUUID());

      expect(root).toBeNull();
    });
  });

  describe('getRootWithLimits', () => {
    it('namespace 상한 값이 NULL이면 limits도 모두 null이다', async () => {
      const namespace = await createNamespace('root-limits-null-ns');

      const result = await repository.getRootWithLimits(namespace.id);

      expect(result?.limits).toEqual({
        maxFileSizeBytes: null,
        maxSyncDeleteNodes: null,
        maxSyncCopyNodes: null,
      });
      expect(result?.root).toMatchObject({ name: '', type: 'DIRECTORY' });
    });

    it('namespace에 설정된 상한 값을 함께 반환한다', async () => {
      const namespace = await createNamespace('root-limits-set-ns');
      await dataSource.getRepository(NamespaceEntity).update(namespace.id, {
        maxFileSizeBytes: '2048',
        maxSyncDeleteNodes: 3,
        maxSyncCopyNodes: 4,
      });

      const result = await repository.getRootWithLimits(namespace.id);

      expect(result?.limits).toEqual({
        maxFileSizeBytes: '2048',
        maxSyncDeleteNodes: 3,
        maxSyncCopyNodes: 4,
      });
    });

    it('존재하지 않는 namespace면 null을 반환한다', async () => {
      const result = await repository.getRootWithLimits(randomUUID());

      expect(result).toBeNull();
    });
  });

  describe('resolvePath', () => {
    it('중첩된 디렉터리 경로를 순서대로 resolve한다', async () => {
      const namespace = await createNamespace('resolve-ns');
      const root = await repository.getRoot(namespace.id);
      const a = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      await repository.ensureDirectory(namespace.id, a.node.id, ['b'], false);

      const resolved = await repository.resolvePath(namespace.id, root!.id, ['a', 'b']);

      expect(resolved).toMatchObject({ name: 'b', type: 'DIRECTORY' });
    });

    it('존재하지 않는 segment면 null을 반환한다', async () => {
      const namespace = await createNamespace('resolve-missing-ns');
      const root = await repository.getRoot(namespace.id);

      const resolved = await repository.resolvePath(namespace.id, root!.id, ['nope']);

      expect(resolved).toBeNull();
    });

    it('중간 segment가 FILE이면 null을 반환한다', async () => {
      const namespace = await createNamespace('resolve-file-blocks-ns');
      const root = await repository.getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a-file');

      const resolved = await repository.resolvePath(namespace.id, root!.id, ['a-file', 'child']);

      expect(resolved).toBeNull();
      expect(file.type).toBe('FILE');
    });
  });

  describe('ensureDirectory', () => {
    it('parents=false로 root 바로 아래 디렉터리를 생성한다', async () => {
      const namespace = await createNamespace('mkdir-simple-ns');
      const root = await repository.getRoot(namespace.id);

      const result = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);

      expect(result).toMatchObject({ created: true, node: { name: 'a', type: 'DIRECTORY' } });
    });

    it('parents=false로 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-no-parent-ns');
      const root = await repository.getRoot(namespace.id);

      await expect(repository.ensureDirectory(namespace.id, root!.id, ['a', 'b'], false)).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });

    it('parents=true면 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('mkdir-p-ns');
      const root = await repository.getRoot(namespace.id);

      const result = await repository.ensureDirectory(namespace.id, root!.id, ['a', 'b', 'c'], true);

      expect(result).toMatchObject({ created: true, node: { name: 'c', type: 'DIRECTORY' } });

      const nodeRepo = dataSource.getRepository(VfsNodeEntity);
      const a = await nodeRepo.findOneByOrFail({ namespaceId: namespace.id, parentId: root!.id, name: 'a' });
      const b = await nodeRepo.findOneByOrFail({ namespaceId: namespace.id, parentId: a.id, name: 'b' });
      expect(b.name).toBe('b');
    });

    it('parents=false로 이미 존재하는 디렉터리를 만들면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-conflict-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['dup'], false);

      await expect(repository.ensureDirectory(namespace.id, root!.id, ['dup'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('parents=true로 이미 존재하는 디렉터리를 만들면 성공하되 created=false다', async () => {
      const namespace = await createNamespace('mkdir-idempotent-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['dup'], true);

      const result = await repository.ensureDirectory(namespace.id, root!.id, ['dup'], true);

      expect(result.created).toBe(false);
      expect(result.node.name).toBe('dup');
    });

    it('대상 경로에 이미 FILE이 있으면 parents 여부와 무관하게 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-over-file-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'blocked');

      await expect(repository.ensureDirectory(namespace.id, root!.id, ['blocked'], true)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('중간 경로에 FILE이 있으면 VfsNotDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-through-file-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'blocker');

      await expect(
        repository.ensureDirectory(namespace.id, root!.id, ['blocker', 'child'], true),
      ).rejects.toThrow(VfsNotDirectoryError);
    });
  });

  describe('listChildren', () => {
    it('name ASC, id ASC 순서로 자식을 나열한다', async () => {
      const namespace = await createNamespace('ls-order-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['b'], false);
      await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      await repository.ensureDirectory(namespace.id, root!.id, ['c'], false);

      const items = await repository.listChildren(namespace.id, root!.id, null, 100);

      expect(items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    });

    it('limit보다 항목이 많으면 limit+1개를 반환해 다음 페이지 존재를 알 수 있게 한다', async () => {
      const namespace = await createNamespace('ls-page-ns');
      const root = await repository.getRoot(namespace.id);
      for (const name of ['a', 'b', 'c']) {
        await repository.ensureDirectory(namespace.id, root!.id, [name], false);
      }

      const items = await repository.listChildren(namespace.id, root!.id, null, 2);

      expect(items).toHaveLength(3);
    });

    it('cursor 이후의 항목만 반환한다', async () => {
      const namespace = await createNamespace('ls-cursor-ns');
      const root = await repository.getRoot(namespace.id);
      for (const name of ['a', 'b', 'c']) {
        await repository.ensureDirectory(namespace.id, root!.id, [name], false);
      }
      const first = await repository.listChildren(namespace.id, root!.id, null, 1);

      const next = await repository.listChildren(
        namespace.id,
        root!.id,
        { name: first[0].name, id: first[0].id },
        100,
      );

      expect(next.map((i) => i.name)).toEqual(['b', 'c']);
    });
  });

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

    it('type 필터로 FILE만 반환한다', async () => {
      const namespace = await createNamespace('find-type-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await repository.findRecursive(namespace.id, root!.id, { type: 'FILE' }, null, 100);

      expect(items.map((i) => i.name).sort()).toEqual(['readme.md', 'report.pdf']);
    });

    it('name exact 필터가 정확히 일치하는 항목만 반환한다', async () => {
      const namespace = await createNamespace('find-exact-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'exact', value: 'readme.md' } },
        null,
        100,
      );

      expect(items.map((i) => i.name)).toEqual(['readme.md']);
    });

    it('name contains 필터가 부분 일치하는 항목을 반환한다', async () => {
      const namespace = await createNamespace('find-contains-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'contains', value: 'epor' } },
        null,
        100,
      );

      expect(items.map((i) => i.name)).toEqual(['report.pdf']);
    });

    it('name prefix/suffix 필터가 동작한다', async () => {
      const namespace = await createNamespace('find-prefix-suffix-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const prefixMatches = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'prefix', value: 'read' } },
        null,
        100,
      );
      const suffixMatches = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'suffix', value: '.pdf' } },
        null,
        100,
      );

      expect(prefixMatches.map((i) => i.name)).toEqual(['readme.md']);
      expect(suffixMatches.map((i) => i.name)).toEqual(['report.pdf']);
    });

    it('name 필터에 LIKE 특수문자가 있어도 리터럴로 취급한다', async () => {
      const namespace = await createNamespace('find-escape-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['100%_done'], false);
      await repository.ensureDirectory(namespace.id, root!.id, ['100xxdone'], false);

      const items = await repository.findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'contains', value: '%_' } },
        null,
        100,
      );

      expect(items.map((i) => i.name)).toEqual(['100%_done']);
    });

    it('각 결과는 시작 경로 기준 상대 segment 배열을 포함한다', async () => {
      const namespace = await createNamespace('find-segments-ns');
      const root = await repository.getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await repository.findRecursive(namespace.id, root!.id, {}, null, 100);

      const report = items.find((i) => i.name === 'report.pdf');
      expect(report?.relativeSegments).toEqual(['a', 'report.pdf']);
    });

    it('cursor 이후의 항목만 반환한다', async () => {
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
  });

  function makeBlobData(
    overrides: Partial<{ storageKey: string; size: string; mimeType: string; sha256: string }> = {},
  ) {
    return {
      storageKey: `blobs/00/${randomUUID()}`,
      size: '0',
      mimeType: 'application/octet-stream',
      sha256: '0'.repeat(64),
      ...overrides,
    };
  }

  describe('touchFile', () => {
    it('대상이 없으면 0-byte file을 생성하고 created를 반환한다', async () => {
      const namespace = await createNamespace('touch-create-ns');
      const root = await repository.getRoot(namespace.id);

      const result = await repository.touchFile(namespace.id, root!.id, ['a.txt'], false, makeBlobData());

      expect(result).toMatchObject({ kind: 'created', node: { name: 'a.txt', type: 'FILE', size: '0' } });
    });

    it('대상 file이 있으면 content는 유지한 채 version만 올린다', async () => {
      const namespace = await createNamespace('touch-existing-ns');
      const root = await repository.getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.touchFile(namespace.id, root!.id, ['a.txt'], false, makeBlobData());

      expect(result.kind).toBe('replaced');
      expect(result.node.blobId).toBe(file.blobId);
      expect(result.node.version).toBe(file.version + 1);
    });

    it('대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('touch-dir-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['adir'], false);

      await expect(
        repository.touchFile(namespace.id, root!.id, ['adir'], false, makeBlobData()),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('parents=true면 중간 디렉터리를 만들며 file을 생성한다', async () => {
      const namespace = await createNamespace('touch-parents-ns');
      const root = await repository.getRoot(namespace.id);

      const result = await repository.touchFile(namespace.id, root!.id, ['a', 'b.txt'], true, makeBlobData());

      expect(result).toMatchObject({ kind: 'created', node: { name: 'b.txt', type: 'FILE' } });
    });

    it('parents=false로 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('touch-no-parent-ns');
      const root = await repository.getRoot(namespace.id);

      await expect(
        repository.touchFile(namespace.id, root!.id, ['a', 'b.txt'], false, makeBlobData()),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });
  });

  describe('putFileContent', () => {
    it('대상이 없으면 새 file을 생성한다', async () => {
      const namespace = await createNamespace('put-create-ns');
      const root = await repository.getRoot(namespace.id);

      const result = await repository.putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ size: '5' }),
        null,
        false,
      );

      expect(result).toMatchObject({ kind: 'created', node: { name: 'a.txt', size: '5' } });
    });

    it('대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('put-dir-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['adir'], false);

      await expect(
        repository.putFileContent(namespace.id, root!.id, ['adir'], false, makeBlobData(), null, false),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('If-Match version이 일치하면 새 Blob으로 교체하고 이전 Blob 참조를 줄인다', async () => {
      const namespace = await createNamespace('put-match-ns');
      const root = await repository.getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ size: '9' }),
        file.version,
        false,
      );

      expect(result).toMatchObject({ kind: 'replaced', node: { size: '9' } });
      expect(result.node.blobId).not.toBe(file.blobId);

      const oldBlob = await dataSource
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });
      expect(oldBlob.referenceCount).toBe(0);
      expect(oldBlob.zeroSince).not.toBeNull();
    });

    it('If-Match version이 불일치하면 VfsVersionConflictError를 던진다', async () => {
      const namespace = await createNamespace('put-conflict-ns');
      const root = await repository.getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        repository.putFileContent(
          namespace.id,
          root!.id,
          ['a.txt'],
          false,
          makeBlobData(),
          file.version + 1,
          false,
        ),
      ).rejects.toThrow(VfsVersionConflictError);
    });

    it('If-Match 없이 force=false면 VfsVersionConflictError를 던진다', async () => {
      const namespace = await createNamespace('put-no-if-match-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        repository.putFileContent(namespace.id, root!.id, ['a.txt'], false, makeBlobData(), null, false),
      ).rejects.toThrow(VfsVersionConflictError);
    });

    it('force=true면 If-Match 없이도 덮어쓴다', async () => {
      const namespace = await createNamespace('put-force-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ size: '3' }),
        null,
        true,
      );

      expect(result).toMatchObject({ kind: 'replaced', node: { size: '3' } });
    });
  });

  describe('moveNode', () => {
    it('같은 디렉터리 내에서 이름을 바꾼다', async () => {
      const namespace = await createNamespace('move-rename-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.moveNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false);

      expect(result).toMatchObject({ finalPath: '/b.txt', node: { name: 'b.txt' } });
      expect(await repository.resolvePath(namespace.id, root!.id, ['a.txt'])).toBeNull();
    });

    it('목적지가 기존 디렉터리면 source basename 아래로 배치한다', async () => {
      const namespace = await createNamespace('move-nest-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.moveNode(namespace.id, root!.id, ['a.txt'], ['dest'], false);

      expect(result.finalPath).toBe('/dest/a.txt');
      const moved = await repository.resolvePath(namespace.id, root!.id, ['dest', 'a.txt']);
      expect(moved).toMatchObject({ name: 'a.txt' });
    });

    it('destinationParents=true면 누락된 목적지 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('move-parents-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.moveNode(namespace.id, root!.id, ['a.txt'], ['x', 'y', 'a.txt'], true);

      expect(result.finalPath).toBe('/x/y/a.txt');
      const dir = await repository.resolvePath(namespace.id, root!.id, ['x', 'y']);
      expect(dir).toMatchObject({ type: 'DIRECTORY' });
    });

    it('destinationParents=false로 목적지 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('move-no-parents-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        repository.moveNode(namespace.id, root!.id, ['a.txt'], ['x', 'a.txt'], false),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('목적지 경로에 이미 file이 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-conflict-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'b.txt');

      await expect(repository.moveNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('목적지 디렉터리 아래 동일 이름이 이미 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-nest-conflict-ns');
      const root = await repository.getRoot(namespace.id);
      const dest = await repository.ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, dest.node.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(repository.moveNode(namespace.id, root!.id, ['a.txt'], ['dest'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('디렉터리를 자기 자신 아래로 move하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('move-self-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(repository.moveNode(namespace.id, root!.id, ['a'], ['a'], false)).rejects.toThrow(
        VfsInvalidOperationError,
      );
    });

    it('디렉터리를 자기 subtree 아래로 move하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('move-subtree-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['a', 'b'], true);

      await expect(repository.moveNode(namespace.id, root!.id, ['a'], ['a', 'b'], false)).rejects.toThrow(
        VfsInvalidOperationError,
      );
    });

    it('file을 정확히 같은 경로로 move하면 자신과 충돌해 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-file-self-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(repository.moveNode(namespace.id, root!.id, ['a.txt'], ['a.txt'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('존재하지 않는 source 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('move-missing-source-ns');
      const root = await repository.getRoot(namespace.id);

      await expect(
        repository.moveNode(namespace.id, root!.id, ['missing.txt'], ['x.txt'], false),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });
  });

  describe('removeEmptyDirectory', () => {
    it('빈 디렉터리를 삭제한다', async () => {
      const namespace = await createNamespace('rmdir-empty-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);

      await repository.removeEmptyDirectory(namespace.id, root!.id, ['a']);

      expect(await repository.resolvePath(namespace.id, root!.id, ['a'])).toBeNull();
    });

    it('비어 있지 않은 디렉터리는 VfsDirectoryNotEmptyError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-nonempty-ns');
      const root = await repository.getRoot(namespace.id);
      const dir = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      await createFile(namespace.id, dir.node.id, 'x.txt');

      await expect(repository.removeEmptyDirectory(namespace.id, root!.id, ['a'])).rejects.toThrow(
        VfsDirectoryNotEmptyError,
      );
    });

    it('FILE 대상이면 VfsNotDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-file-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(repository.removeEmptyDirectory(namespace.id, root!.id, ['a.txt'])).rejects.toThrow(
        VfsNotDirectoryError,
      );
    });

    it('존재하지 않는 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-missing-ns');
      const root = await repository.getRoot(namespace.id);

      await expect(repository.removeEmptyDirectory(namespace.id, root!.id, ['missing'])).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });
  });

  describe('removeNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('FILE을 삭제하면 Blob reference_count를 감소시킨다', async () => {
      const namespace = await createNamespace('rm-file-ns');
      const root = await repository.getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      await repository.removeNode(namespace.id, root!.id, ['a.txt'], false, UNLIMITED);

      expect(await repository.resolvePath(namespace.id, root!.id, ['a.txt'])).toBeNull();
      const blob = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: file.blobId as string });
      expect(blob.referenceCount).toBe(0);
      expect(blob.zeroSince).not.toBeNull();
    });

    it('recursive=false로 directory를 삭제하려 하면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('rm-dir-non-recursive-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(
        repository.removeNode(namespace.id, root!.id, ['a'], false, UNLIMITED),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

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
      expect(blobB.zeroSince).not.toBeNull();
      expect(blobD.referenceCount).toBe(0);
      expect(blobD.zeroSince).not.toBeNull();
    });

    it('같은 Blob을 여러 Node가 참조하면 recursive delete가 감소량을 합산한다', async () => {
      const namespace = await createNamespace('rm-shared-blob-ns');
      const root = await repository.getRoot(namespace.id);
      const dir = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      const nodeRepo = dataSource.getRepository(VfsNodeEntity);
      const blobRepo = dataSource.getRepository(BlobEntity);
      const sharedBlob = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: `blobs/00/${randomUUID()}`,
          size: '0',
          mimeType: 'application/octet-stream',
          sha256: '0'.repeat(64),
          referenceCount: 2,
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'x.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'y.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );

      await repository.removeNode(namespace.id, root!.id, ['a'], true, UNLIMITED);

      expect((await blobRepo.findOneByOrFail({ id: sharedBlob.id })).referenceCount).toBe(0);
    });

    it('존재하지 않는 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('rm-missing-ns');
      const root = await repository.getRoot(namespace.id);

      await expect(
        repository.removeNode(namespace.id, root!.id, ['missing.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('MAX_SYNC_DELETE_NODES를 넘으면 작업 시작 전에 VfsDeleteLimitExceededError를 던지고 아무것도 삭제하지 않는다', async () => {
      const namespace = await createNamespace('rm-limit-ns');
      const root = await repository.getRoot(namespace.id);
      const dir = await repository.ensureDirectory(namespace.id, root!.id, ['big'], false);
      await createFile(namespace.id, dir.node.id, '1.txt');
      await createFile(namespace.id, dir.node.id, '2.txt');
      await createFile(namespace.id, dir.node.id, '3.txt');
      // dir 자신 포함 4개 Node > 상한 2

      await expect(repository.removeNode(namespace.id, root!.id, ['big'], true, 2)).rejects.toThrow(
        VfsDeleteLimitExceededError,
      );

      expect(await repository.resolvePath(namespace.id, root!.id, ['big'])).not.toBeNull();
      expect(await repository.resolvePath(namespace.id, root!.id, ['big', '1.txt'])).not.toBeNull();
    });
  });

  describe('copyNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('COW: source와 같은 blob을 참조하는 새 Node를 만들고 reference_count를 늘린다', async () => {
      const namespace = await createNamespace('cp-cow-ns');
      const root = await repository.getRoot(namespace.id);
      const source = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED);

      expect(result).toMatchObject({ finalPath: '/b.txt', node: { name: 'b.txt', blobId: source.blobId } });
      const blob = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: source.blobId as string });
      expect(blob.referenceCount).toBe(2);
      expect(await repository.resolvePath(namespace.id, root!.id, ['a.txt'])).toMatchObject({
        blobId: source.blobId,
      });
    });

    it('목적지가 기존 디렉터리면 source basename 아래로 배치한다', async () => {
      const namespace = await createNamespace('cp-nest-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.copyNode(namespace.id, root!.id, ['a.txt'], ['dest'], false, UNLIMITED);

      expect(result.finalPath).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 목적지 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('cp-parents-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await repository.copyNode(
        namespace.id,
        root!.id,
        ['a.txt'],
        ['x', 'y', 'a.txt'],
        true,
        UNLIMITED,
      );

      expect(result.finalPath).toBe('/x/y/a.txt');
    });

    it('destinationParents=false로 목적지 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('cp-no-parents-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        repository.copyNode(namespace.id, root!.id, ['a.txt'], ['x', 'a.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('목적지 경로에 이미 파일이 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('cp-conflict-ns');
      const root = await repository.getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'b.txt');

      await expect(
        repository.copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsAlreadyExistsError);
    });

    it('디렉터리를 자기 자신 아래로 복사하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('cp-self-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(
        repository.copyNode(namespace.id, root!.id, ['a'], ['a'], false, UNLIMITED),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('디렉터리를 자기 subtree 아래로 복사하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('cp-subtree-ns');
      const root = await repository.getRoot(namespace.id);
      await repository.ensureDirectory(namespace.id, root!.id, ['a', 'b'], true);

      await expect(
        repository.copyNode(namespace.id, root!.id, ['a'], ['a', 'b'], false, UNLIMITED),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('recursive: 하위 트리를 전부 복사하고 각 file의 Blob reference_count를 늘린다', async () => {
      const namespace = await createNamespace('cp-recursive-ns');
      const root = await repository.getRoot(namespace.id);
      const a = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      const c = await repository.ensureDirectory(namespace.id, root!.id, ['a', 'c'], false);
      const fileB = await createFile(namespace.id, a.node.id, 'b.txt');
      const fileD = await createFile(namespace.id, c.node.id, 'd.txt');

      const result = await repository.copyNode(namespace.id, root!.id, ['a'], ['a2'], false, UNLIMITED);

      expect(result.finalPath).toBe('/a2');
      expect(await repository.resolvePath(namespace.id, root!.id, ['a2', 'b.txt'])).toMatchObject({
        blobId: fileB.blobId,
      });
      expect(await repository.resolvePath(namespace.id, root!.id, ['a2', 'c', 'd.txt'])).toMatchObject({
        blobId: fileD.blobId,
      });
      expect(await repository.resolvePath(namespace.id, root!.id, ['a', 'b.txt'])).not.toBeNull();
      const blobRepo = dataSource.getRepository(BlobEntity);
      expect((await blobRepo.findOneByOrFail({ id: fileB.blobId as string })).referenceCount).toBe(2);
      expect((await blobRepo.findOneByOrFail({ id: fileD.blobId as string })).referenceCount).toBe(2);
    });

    it('같은 Blob을 여러 Node가 참조하는 subtree를 복사하면 증가량을 합산한다', async () => {
      const namespace = await createNamespace('cp-shared-blob-ns');
      const root = await repository.getRoot(namespace.id);
      const dir = await repository.ensureDirectory(namespace.id, root!.id, ['a'], false);
      const nodeRepo = dataSource.getRepository(VfsNodeEntity);
      const blobRepo = dataSource.getRepository(BlobEntity);
      const sharedBlob = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: `blobs/00/${randomUUID()}`,
          size: '0',
          mimeType: 'application/octet-stream',
          sha256: '0'.repeat(64),
          referenceCount: 2,
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'x.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );
      await nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: dir.node.id,
          type: 'FILE',
          name: 'y.txt',
          blobId: sharedBlob.id,
          size: '0',
          mimeType: 'application/octet-stream',
        }),
      );

      await repository.copyNode(namespace.id, root!.id, ['a'], ['a2'], false, UNLIMITED);

      expect((await blobRepo.findOneByOrFail({ id: sharedBlob.id })).referenceCount).toBe(4);
    });

    it('write-after-copy: 복사된 Node를 write하면 새 Blob으로 교체되고 원본은 영향받지 않는다', async () => {
      const namespace = await createNamespace('cp-detach-ns');
      const root = await repository.getRoot(namespace.id);
      const source = await createFile(namespace.id, root!.id, 'a.txt');

      await repository.copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED);
      const sharedBlobId = source.blobId as string;
      const copied = await repository.resolvePath(namespace.id, root!.id, ['b.txt']);

      const outcome = await repository.putFileContent(
        namespace.id,
        root!.id,
        ['b.txt'],
        false,
        makeBlobData({ size: '9' }),
        copied!.version,
        false,
      );

      expect(outcome).toMatchObject({ kind: 'replaced', node: { size: '9' } });
      const blobRepo = dataSource.getRepository(BlobEntity);
      const shared = await blobRepo.findOneByOrFail({ id: sharedBlobId });
      expect(shared.referenceCount).toBe(1);
      expect(await repository.resolvePath(namespace.id, root!.id, ['a.txt'])).toMatchObject({
        blobId: sharedBlobId,
      });
      const b = await repository.resolvePath(namespace.id, root!.id, ['b.txt']);
      expect(b!.blobId).not.toBe(sharedBlobId);
    });

    it('독립적으로 업로드한 동일 content는 deduplicate하지 않는다', async () => {
      const namespace = await createNamespace('cp-no-dedup-ns');
      const root = await repository.getRoot(namespace.id);
      const sha256 = '1'.repeat(64);

      const first = await repository.putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ sha256 }),
        null,
        false,
      );
      const second = await repository.putFileContent(
        namespace.id,
        root!.id,
        ['b.txt'],
        false,
        makeBlobData({ sha256 }),
        null,
        false,
      );

      expect(first.kind).toBe('created');
      expect(second.kind).toBe('created');
      const aNode = await repository.resolvePath(namespace.id, root!.id, ['a.txt']);
      const bNode = await repository.resolvePath(namespace.id, root!.id, ['b.txt']);
      expect(aNode!.blobId).not.toBe(bNode!.blobId);
    });

    it('존재하지 않는 source 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('cp-missing-source-ns');
      const root = await repository.getRoot(namespace.id);

      await expect(
        repository.copyNode(namespace.id, root!.id, ['missing.txt'], ['x.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('MAX_SYNC_COPY_NODES를 넘으면 작업 시작 전에 VfsCopyLimitExceededError를 던지고 아무것도 만들지 않는다', async () => {
      const namespace = await createNamespace('cp-limit-ns');
      const root = await repository.getRoot(namespace.id);
      const dir = await repository.ensureDirectory(namespace.id, root!.id, ['big'], false);
      await createFile(namespace.id, dir.node.id, '1.txt');
      await createFile(namespace.id, dir.node.id, '2.txt');
      await createFile(namespace.id, dir.node.id, '3.txt');
      // dir 자신 포함 4개 Node > 상한 2

      await expect(
        repository.copyNode(namespace.id, root!.id, ['big'], ['copy'], false, 2),
      ).rejects.toThrow(VfsCopyLimitExceededError);

      expect(await repository.resolvePath(namespace.id, root!.id, ['copy'])).toBeNull();
    });
  });

  describe('getBlobStorageKey', () => {
    it('존재하는 blob의 storage key를 반환한다', async () => {
      const namespace = await createNamespace('blob-key-ns');
      const root = await repository.getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');
      const expected = await dataSource
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });

      const key = await repository.getBlobStorageKey(namespace.id, file.blobId as string);

      expect(key).toBe(expected.storageKey);
    });

    it('존재하지 않는 blobId는 null을 반환한다', async () => {
      const namespace = await createNamespace('blob-key-missing-ns');

      const key = await repository.getBlobStorageKey(namespace.id, randomUUID());

      expect(key).toBeNull();
    });
  });
});
