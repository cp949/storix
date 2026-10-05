import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';
import { encodeRevision } from '../../../src/vfs/revision.js';
import { VfsPreconditionFailedError } from '../../../src/vfs/vfs.errors.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';

export function runRepositoryReadsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getRepo, getDs, createNamespace, createFile, makeBlobData } = helpers;
  describe('revision snapshot reads', () => {
    it('invalidates a cursor after a descendant changes but not after an independent branch changes', async () => {
      const namespace = await createNamespace('revision-snapshot-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['b'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'x'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'y'], false);
      const first = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 1);
      const cursor = {
        directoryId: first.directory.id,
        directoryRevision: encodeRevision(first.directory),
        name: first.rows[0].name,
        id: first.rows[0].id,
      };
      await getRepo().ensureDirectory(namespace.id, root.id, ['b', 'other'], false);
      expect(
        (await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', cursor, 1)).rows[0].name,
      ).toBe('y');
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x', 'code.py'],
        false,
        makeBlobData(),
        null,
        false,
      );
      await expect(
        getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', cursor, 1),
      ).rejects.toThrow(VfsPreconditionFailedError);
      // 다른 디렉터리의 cursor는 교체된 디렉터리의 cursor와 서버가 구분할 수 없으므로 같은 412다.
      await expect(
        getRepo().listRevisionChildren(namespace.id, root.id, ['b'], '/b', cursor, 1),
      ).rejects.toThrow(VfsPreconditionFailedError);
    });

    it('같은 경로의 디렉터리가 교체되면 옛 cursor는 400이 아니라 412이고 current는 새 디렉터리다', async () => {
      const namespace = await createNamespace('revision-replaced-dir-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'x'], true);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'y'], false);
      const first = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 1);
      const cursor = {
        directoryId: first.directory.id,
        directoryRevision: encodeRevision(first.directory),
        name: first.rows[0].name,
        id: first.rows[0].id,
      };
      await getRepo().removeNode(namespace.id, root.id, ['a'], true, 10);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'x'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'y'], false);

      const rejected = await getRepo()
        .listRevisionChildren(namespace.id, root.id, ['a'], '/a', cursor, 1)
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(VfsPreconditionFailedError);
      const replaced = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 1);
      expect(replaced.directory.id).not.toBe(first.directory.id);
      expect((rejected as VfsPreconditionFailedError).current).toMatchObject({
        revision: encodeRevision(replaced.directory),
      });
    });

    it('reads directory and child revisions from one transaction during a concurrent content change', async () => {
      const namespace = await createNamespace('revision-read-write-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      const first = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const before = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 10);
      const [read] = await Promise.all([
        getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 10),
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['a', 'x'],
          false,
          makeBlobData(),
          first.node.version,
          false,
        ),
      ]);
      const after = await getRepo().listRevisionChildren(namespace.id, root.id, ['a'], '/a', null, 10);
      expect([
        [before.directory.version, before.rows[0].version],
        [after.directory.version, after.rows[0].version],
      ]).toContainEqual([read.directory.version, read.rows[0].version]);
    });
  });

  describe('findRecursive', () => {
    it('find 결과에 node의 expiresAt을 포함한다', async () => {
      const namespace = await createNamespace(`find-expiry-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const file = await createFile(namespace.id, root.id, 'temp.bin');
      const expiresAt = new Date('2030-01-01T00:00:00.000Z');
      await getDs().getRepository(VfsNodeEntity).update({ id: file.id }, { expiresAt });
      await createFile(namespace.id, root.id, 'kept.bin');

      const matches = await getRepo().findRecursive(namespace.id, root.id, {}, null, 10);

      expect(matches.map((match) => [match.name, match.expiresAt?.toISOString() ?? null])).toEqual([
        ['kept.bin', null],
        ['temp.bin', '2030-01-01T00:00:00.000Z'],
      ]);
    });

    async function buildTree(namespace: { id: string }, root: { id: string }) {
      const a = await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      await getRepo().ensureDirectory(namespace.id, a.node.id, ['b'], false);
      await createFile(namespace.id, a.node.id, 'report.pdf');
      await createFile(namespace.id, root.id, 'readme.md');
      return a.node;
    }

    it('시작 경로 하위를 재귀적으로 모두 반환한다', async () => {
      const namespace = await createNamespace('find-all-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 100);

      expect(items.map((i) => i.name).sort()).toEqual(['a', 'b', 'readme.md', 'report.pdf'].sort());
    });

    it('type 필터로 FILE만 반환한다', async () => {
      const namespace = await createNamespace('find-type-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, { type: 'FILE' }, null, 100);

      expect(items.map((i) => i.name).sort()).toEqual(['readme.md', 'report.pdf']);
    });

    it('name exact 필터가 정확히 일치하는 항목만 반환한다', async () => {
      const namespace = await createNamespace('find-exact-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(
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
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(
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
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const prefixMatches = await getRepo().findRecursive(
        namespace.id,
        root!.id,
        { name: { mode: 'prefix', value: 'read' } },
        null,
        100,
      );
      const suffixMatches = await getRepo().findRecursive(
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
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['100%_done'], false);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['100xxdone'], false);

      const items = await getRepo().findRecursive(
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
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 100);

      const report = items.find((i) => i.name === 'report.pdf');
      expect(report?.relativeSegments).toEqual(['a', 'report.pdf']);
    });

    it('createdAt/updatedAt을 Date 인스턴스로 반환한다', async () => {
      const namespace = await createNamespace('find-dates-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const items = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 100);

      for (const item of items) {
        expect(item.createdAt).toBeInstanceOf(Date);
        expect(item.updatedAt).toBeInstanceOf(Date);
        expect(Number.isNaN(item.createdAt.getTime())).toBe(false);
      }
    });

    it('cursor 이후의 항목만 반환한다', async () => {
      const namespace = await createNamespace('find-cursor-ns');
      const root = await getRepo().getRoot(namespace.id);
      await buildTree(namespace, root!);

      const first = await getRepo().findRecursive(namespace.id, root!.id, {}, null, 1);
      const next = await getRepo().findRecursive(
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
}
import { randomUUID } from 'node:crypto';
