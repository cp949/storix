import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';
import { BlobEntity } from '../../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import { decodeRevision } from '../../../src/vfs/revision.js';
import { VfsRevisionExhaustedError, VfsVersionConflictError } from '../../../src/vfs/vfs.errors.js';

export function runMutationRevisionsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, makeBlobData } = helpers;
  describe('mutation revisions', () => {
    it('increments root and existing ancestors once for create and overwrite', async () => {
      const namespace = await createNamespace('mutation-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const directory = await getRepo().ensureDirectory(namespace.id, root.id, ['a'], false);
      const rootAfterDirectory = (await getRepo().getRoot(namespace.id))!;
      expect(rootAfterDirectory.version).toBe(root.version + 1);

      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      expect(created.node.version).toBe(1);
      const aAfterCreate = (await getRepo().resolvePath(namespace.id, root.id, ['a']))!;
      expect(aAfterCreate.version).toBe(directory.node.version + 1);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootAfterDirectory.version + 1);

      const replaced = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'x'],
        false,
        makeBlobData(),
        created.node.version,
        false,
      );
      expect(replaced.node.version).toBe(created.node.version + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['a']))!.version).toBe(
        aAfterCreate.version + 1,
      );
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootAfterDirectory.version + 2);
    });

    it('does not change revisions or blob references after a failed numeric condition', async () => {
      const namespace = await createNamespace('mutation-conflict-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const rootBefore = (await getRepo().getRoot(namespace.id))!;
      const blobBefore = await getDs().getRepository(BlobEntity).find();
      await expect(
        getRepo().putFileContent(
          namespace.id,
          root.id,
          ['x'],
          false,
          makeBlobData(),
          created.node.version + 1,
          false,
        ),
      ).rejects.toThrow(VfsVersionConflictError);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootBefore.version);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['x']))!.version).toBe(created.node.version);
      expect(
        (await getDs().getRepository(BlobEntity).find()).map((blob) => [blob.id, blob.referenceCount]),
      ).toEqual(blobBefore.map((blob) => [blob.id, blob.referenceCount]));
    });

    it('changes a moved subtree and old and new ancestors once', async () => {
      const namespace = await createNamespace('mutation-move-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['a', 'sub'], true);
      await getRepo().ensureDirectory(namespace.id, root.id, ['b'], false);
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a', 'sub', 'x'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const before = {
        root: (await getRepo().getRoot(namespace.id))!.version,
        a: (await getRepo().resolvePath(namespace.id, root.id, ['a']))!.version,
        b: (await getRepo().resolvePath(namespace.id, root.id, ['b']))!.version,
        sub: (await getRepo().resolvePath(namespace.id, root.id, ['a', 'sub']))!.version,
        x: (await getRepo().resolvePath(namespace.id, root.id, ['a', 'sub', 'x']))!.version,
      };
      await getRepo().moveNode(namespace.id, root.id, ['a', 'sub'], ['b'], false);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(before.root + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['a']))!.version).toBe(before.a + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['b']))!.version).toBe(before.b + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['b', 'sub']))!.version).toBe(
        before.sub + 1,
      );
      expect((await getRepo().resolvePath(namespace.id, root.id, ['b', 'sub', 'x']))!.version).toBe(
        before.x + 1,
      );
    });

    it('reports surviving affected paths in canonical order', async () => {
      const namespace = await createNamespace('mutation-affected-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const result = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().ensureDirectory(namespace.id, root.id, ['a', 'b'], true, tx),
      );
      expect(result.affectedRevisions.map((item) => item.path)).toEqual(['/', '/a', '/a/b']);
      for (const item of result.affectedRevisions) {
        expect(decodeRevision(item.revision).version).toBe(1 + Number(item.path === '/'));
      }
    });

    it('copies nodes without changing source revisions', async () => {
      const namespace = await createNamespace('mutation-copy-revisions-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getRepo().ensureDirectory(namespace.id, root.id, ['src'], false);
      await getRepo().putFileContent(namespace.id, root.id, ['src', 'x'], false, makeBlobData(), null, false);
      const source = (await getRepo().resolvePath(namespace.id, root.id, ['src']))!;
      const file = (await getRepo().resolvePath(namespace.id, root.id, ['src', 'x']))!;
      const rootBefore = (await getRepo().getRoot(namespace.id))!;
      await getRepo().copyNode(namespace.id, root.id, ['src'], ['copy'], false, 100);
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(rootBefore.version + 1);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['src']))!.version).toBe(source.version);
      expect((await getRepo().resolvePath(namespace.id, root.id, ['src', 'x']))!.version).toBe(file.version);
      const copied = (await getRepo().resolvePath(namespace.id, root.id, ['copy']))!;
      const copiedFile = (await getRepo().resolvePath(namespace.id, root.id, ['copy', 'x']))!;
      expect(copied.id).not.toBe(source.id);
      expect(copied.version).toBe(1);
      expect(copiedFile.id).not.toBe(file.id);
      expect(copiedFile.version).toBe(1);
    });

    it('rolls back mutation when an ancestor version reaches the database ceiling', async () => {
      const namespace = await createNamespace('mutation-ceiling-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await getDs().getRepository(VfsNodeEntity).update(root.id, { version: 2147483647 });
      await expect(getRepo().ensureDirectory(namespace.id, root.id, ['a'], false)).rejects.toThrow(
        VfsRevisionExhaustedError,
      );
      expect(await getRepo().resolvePath(namespace.id, root.id, ['a'])).toBeNull();
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(2147483647);
    });

    it('rejects an exhausted target version with the domain error', async () => {
      const namespace = await createNamespace('mutation-target-ceiling-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().touchFile(namespace.id, root.id, ['x'], false, makeBlobData());
      await getDs().getRepository(VfsNodeEntity).update(created.node.id, { version: 2147483647 });
      await expect(getRepo().touchFile(namespace.id, root.id, ['x'], false, makeBlobData())).rejects.toThrow(
        VfsRevisionExhaustedError,
      );
      expect((await getRepo().resolvePath(namespace.id, root.id, ['x']))!.version).toBe(2147483647);
    });

    it('rolls back metadata and revisions if the commit hook fails', async () => {
      const namespace = await createNamespace('mutation-hook-rollback-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      await expect(
        getRepo().withMutation(
          namespace.id,
          root.id,
          (tx) => getRepo().ensureDirectory(namespace.id, root.id, ['a'], false, tx),
          async () => {
            throw new Error('receipt write failed');
          },
        ),
      ).rejects.toThrow('receipt write failed');
      expect(await getRepo().resolvePath(namespace.id, root.id, ['a'])).toBeNull();
      expect((await getRepo().getRoot(namespace.id))!.version).toBe(root.version);
    });
  });
}
