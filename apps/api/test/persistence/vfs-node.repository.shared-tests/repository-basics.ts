import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';
import { randomUUID } from 'node:crypto';
import { BlobEntity } from '../../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import {
  VfsAlreadyExistsError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsQuotaExceededError,
} from '../../../src/vfs/vfs.errors.js';

export function runRepositoryBasicsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, createFile, makeBlobData } = helpers;
  describe('getRoot', () => {
    it('존재하는 namespace의 root node를 반환한다', async () => {
      const namespace = await createNamespace('get-root-ns');

      const root = await getRepo().getRoot(namespace.id);

      expect(root).toMatchObject({ name: '', type: 'DIRECTORY' });
    });

    it('존재하지 않는 namespace면 null을 반환한다', async () => {
      const root = await getRepo().getRoot(randomUUID());

      expect(root).toBeNull();
    });
  });

  describe('namespace total logical quota', () => {
    it('denies an over-limit create and overwrite without persisting node, blob, revision, or usage', async () => {
      const namespace = await createNamespace('logical-quota-node-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '3' });
      const root = (await getRepo().getRoot(namespace.id))!;

      await expect(
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['too-large'],
          false,
          makeBlobData({ size: '4' }),
          null,
          false,
        ),
      ).rejects.toThrow(VfsQuotaExceededError);
      expect(await getRepo().resolvePath(namespace.id, root.id, ['too-large'])).toBeNull();
      expect(await getDs().getRepository(BlobEntity).countBy({ namespaceId: namespace.id })).toBe(0);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('0');

      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['file'],
        false,
        makeBlobData({ size: '3' }),
        null,
        false,
      );
      const revisionBeforeDeniedOverwrite = (await getRepo().getRoot(namespace.id))!.version;
      await expect(
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['file'],
          false,
          makeBlobData({ size: '4' }),
          created.node.version,
          false,
        ),
      ).rejects.toThrow(VfsQuotaExceededError);
      expect(String((await getRepo().resolvePath(namespace.id, root.id, ['file']))?.size)).toBe('3');
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(revisionBeforeDeniedOverwrite);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('3');
    });

    it('subtracts live bytes on delete and permits zero or negative deltas while over quota', async () => {
      const namespace = await createNamespace('logical-quota-delete-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '3' });
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['file'],
        false,
        makeBlobData({ size: '3' }),
        null,
        false,
      );
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '2' });

      await getRepo().touchFile(namespace.id, root.id, ['file'], false, makeBlobData());
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('3');
      await getRepo().removeNode(namespace.id, root.id, ['file'], false, 100);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('0');
    });

    it('move keeps usage unchanged while COW copy adds logical bytes and is rolled back over limit', async () => {
      const namespace = await createNamespace('logical-quota-copy-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '5' });
      const root = (await getRepo().getRoot(namespace.id))!;
      const file = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['file'],
        false,
        makeBlobData({ size: '3' }),
        null,
        false,
      );

      await getRepo().moveNode(namespace.id, root.id, ['file'], ['moved'], false);
      await expect(
        getRepo().copyNode(namespace.id, root.id, ['moved'], ['copy'], false, 100),
      ).rejects.toThrow(VfsQuotaExceededError);
      expect(await getRepo().resolvePath(namespace.id, root.id, ['copy'])).toBeNull();
      expect((await getRepo().resolvePath(namespace.id, root.id, ['moved']))?.id).toBe(file.node.id);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('3');
    });

    it('serializes concurrent positive deltas at the namespace root lock', async () => {
      const namespace = await createNamespace('logical-quota-race-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, { maxTotalLogicalBytes: '5' });
      const root = (await getRepo().getRoot(namespace.id))!;
      const write = (name: string) =>
        getRepo().putFileContent(
          namespace.id,
          root.id,
          [name],
          false,
          makeBlobData({ size: '4' }),
          null,
          false,
        );

      const outcomes = await Promise.allSettled([write('first'), write('second')]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const error = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(error.reason).toBeInstanceOf(VfsQuotaExceededError);
      expect(
        String(
          (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id }))
            .liveFileByteCount,
        ),
      ).toBe('4');
    });
  });

  describe('getRootWithLimits', () => {
    it('namespace 상한 값이 NULL이면 limits도 모두 null이다', async () => {
      const namespace = await createNamespace('root-limits-null-ns');

      const result = await getRepo().getRootWithLimits(namespace.id);

      expect(result?.limits).toEqual({
        maxFileSizeBytes: null,
        maxSyncDeleteNodes: null,
        maxSyncCopyNodes: null,
        encryptionPolicy: 'NONE',
        accessPolicy: 'PRIVATE',
      });
      expect(result?.root).toMatchObject({ name: '', type: 'DIRECTORY' });
    });

    it('namespace에 설정된 상한 값을 함께 반환한다', async () => {
      const namespace = await createNamespace('root-limits-set-ns');
      await getDs().getRepository(NamespaceEntity).update(namespace.id, {
        maxFileSizeBytes: '2048',
        maxSyncDeleteNodes: 3,
        maxSyncCopyNodes: 4,
      });

      const result = await getRepo().getRootWithLimits(namespace.id);

      expect(result?.limits).toEqual({
        maxFileSizeBytes: '2048',
        maxSyncDeleteNodes: 3,
        maxSyncCopyNodes: 4,
        encryptionPolicy: 'NONE',
        accessPolicy: 'PRIVATE',
      });
    });

    it('존재하지 않는 namespace면 null을 반환한다', async () => {
      const result = await getRepo().getRootWithLimits(randomUUID());

      expect(result).toBeNull();
    });
  });

  describe('resolvePath', () => {
    it('중첩된 디렉터리 경로를 순서대로 resolve한다', async () => {
      const namespace = await createNamespace('resolve-ns');
      const root = await getRepo().getRoot(namespace.id);
      const a = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, a.node.id, ['b'], false);

      const resolved = await getRepo().resolvePath(namespace.id, root!.id, ['a', 'b']);

      expect(resolved).toMatchObject({ name: 'b', type: 'DIRECTORY' });
    });

    it('존재하지 않는 segment면 null을 반환한다', async () => {
      const namespace = await createNamespace('resolve-missing-ns');
      const root = await getRepo().getRoot(namespace.id);

      const resolved = await getRepo().resolvePath(namespace.id, root!.id, ['nope']);

      expect(resolved).toBeNull();
    });

    it('중간 segment가 FILE이면 null을 반환한다', async () => {
      const namespace = await createNamespace('resolve-file-blocks-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a-file');

      const resolved = await getRepo().resolvePath(namespace.id, root!.id, ['a-file', 'child']);

      expect(resolved).toBeNull();
      expect(file.type).toBe('FILE');
    });
  });

  describe('ensureDirectory', () => {
    it('parents=false로 root 바로 아래 디렉터리를 생성한다', async () => {
      const namespace = await createNamespace('mkdir-simple-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      expect(result).toMatchObject({ created: true, node: { name: 'a', type: 'DIRECTORY' } });
    });

    it('parents=false로 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-no-parent-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b'], false)).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });

    it('parents=true면 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('mkdir-p-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b', 'c'], true);

      expect(result).toMatchObject({ created: true, node: { name: 'c', type: 'DIRECTORY' } });

      const nodeRepo = getDs().getRepository(VfsNodeEntity);
      const a = await nodeRepo.findOneByOrFail({ namespaceId: namespace.id, parentId: root!.id, name: 'a' });
      const b = await nodeRepo.findOneByOrFail({ namespaceId: namespace.id, parentId: a.id, name: 'b' });
      expect(b.name).toBe('b');
    });

    it('parents=false로 이미 존재하는 디렉터리를 만들면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], false);

      await expect(getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], false)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('parents=true로 이미 존재하는 디렉터리를 만들면 성공하되 created=false다', async () => {
      const namespace = await createNamespace('mkdir-idempotent-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], true);

      const result = await getRepo().ensureDirectory(namespace.id, root!.id, ['dup'], true);

      expect(result.created).toBe(false);
      expect(result.node.name).toBe('dup');
    });

    it('대상 경로에 이미 FILE이 있으면 parents 여부와 무관하게 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-over-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'blocked');

      await expect(getRepo().ensureDirectory(namespace.id, root!.id, ['blocked'], true)).rejects.toThrow(
        VfsAlreadyExistsError,
      );
    });

    it('중간 경로에 FILE이 있으면 VfsNotDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('mkdir-through-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'blocker');

      await expect(
        getRepo().ensureDirectory(namespace.id, root!.id, ['blocker', 'child'], true),
      ).rejects.toThrow(VfsNotDirectoryError);
    });
  });

  describe('listChildren', () => {
    it('name ASC, id ASC 순서로 자식을 나열한다', async () => {
      const namespace = await createNamespace('ls-order-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['b'], false);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['c'], false);

      const items = await getRepo().listChildren(namespace.id, root!.id, null, 100);

      expect(items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    });

    it('limit보다 항목이 많으면 limit+1개를 반환해 다음 페이지 존재를 알 수 있게 한다', async () => {
      const namespace = await createNamespace('ls-page-ns');
      const root = await getRepo().getRoot(namespace.id);
      for (const name of ['a', 'b', 'c']) {
        await getRepo().ensureDirectory(namespace.id, root!.id, [name], false);
      }

      const items = await getRepo().listChildren(namespace.id, root!.id, null, 2);

      expect(items).toHaveLength(3);
    });

    it('cursor 이후의 항목만 반환한다', async () => {
      const namespace = await createNamespace('ls-cursor-ns');
      const root = await getRepo().getRoot(namespace.id);
      for (const name of ['a', 'b', 'c']) {
        await getRepo().ensureDirectory(namespace.id, root!.id, [name], false);
      }
      const first = await getRepo().listChildren(namespace.id, root!.id, null, 1);

      const next = await getRepo().listChildren(
        namespace.id,
        root!.id,
        { name: first[0].name, id: first[0].id },
        100,
      );

      expect(next.map((i) => i.name)).toEqual(['b', 'c']);
    });
  });
}
