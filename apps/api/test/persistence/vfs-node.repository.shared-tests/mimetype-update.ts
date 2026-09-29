import { randomUUID } from 'node:crypto';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import { encodeRevision } from '../../../src/vfs/revision.js';
import {
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsPreconditionFailedError,
} from '../../../src/vfs/vfs.errors.js';
import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';

export function runMimeTypeUpdateTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, makeBlobData } = helpers;

  describe('setMimeType', () => {
    const setMimeType = (
      namespaceId: string,
      rootId: string,
      path: string,
      ifRevision: string,
      mimeType: string,
    ) =>
      getRepo().withMutation(namespaceId, rootId, (tx) =>
        getRepo().applyConditionalMutation(tx, {
          kind: 'setMimeType',
          path,
          segments: path.split('/').filter(Boolean),
          ifRevision,
          mimeType,
        }),
      );

    it('성공하면 mimeType과 revision이 바뀌고 affectedRevisions에 대상+조상이 담긴다', async () => {
      const namespace = await createNamespace(`set-mimetype-ok-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const dir = await getRepo().ensureDirectory(namespace.id, root.id, ['dir'], false);
      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['dir', 'a.bin'],
        false,
        makeBlobData({ mimeType: 'text/plain' }),
        null,
        false,
      );

      const nodes = getDs().getRepository(VfsNodeEntity);
      const dirBefore = await nodes.findOneByOrFail({ id: dir.node.id });

      const result = await setMimeType(
        namespace.id,
        root.id,
        '/dir/a.bin',
        encodeRevision(created.node),
        'image/png',
      );

      const stored = await nodes.findOneByOrFail({ id: created.node.id });
      expect(stored.mimeType).toBe('image/png');
      expect(stored.version).toBe(created.node.version + 1);
      expect(result.value).toMatchObject({
        status: 200,
        resource: { id: created.node.id, mimeType: 'image/png' },
      });
      expect(result.affectedRevisions).toContainEqual({
        path: '/dir/a.bin',
        revision: encodeRevision(stored),
      });
      const dirAfter = await nodes.findOneByOrFail({ id: dir.node.id });
      expect(dirAfter.version).toBe(dirBefore.version + 1);
      expect(result.affectedRevisions).toContainEqual({
        path: '/dir',
        revision: encodeRevision(dirAfter),
      });
    });

    it('요청 값이 현재 값과 같으면 변경 없이 200이고 revision을 유지한다', async () => {
      const namespace = await createNamespace(`set-mimetype-noop-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a.bin'],
        false,
        makeBlobData({ mimeType: 'text/plain' }),
        null,
        false,
      );

      const result = await setMimeType(
        namespace.id,
        root.id,
        '/a.bin',
        encodeRevision(created.node),
        'text/plain',
      );

      expect(result.value.status).toBe(200);
      expect(result.affectedRevisions).toEqual([]);
      const stored = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: created.node.id });
      expect(stored.version).toBe(created.node.version);
      expect(stored.mimeType).toBe('text/plain');
    });

    it('대상이 디렉터리면 revision 검사보다 먼저 409를 던진다', async () => {
      const namespace = await createNamespace(`set-mimetype-dir-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const dir = await getRepo().ensureDirectory(namespace.id, root.id, ['dir'], false);
      const stale = encodeRevision({ id: dir.node.id, version: dir.node.version + 5 });

      await expect(setMimeType(namespace.id, root.id, '/dir', stale, 'image/png')).rejects.toBeInstanceOf(
        VfsIsDirectoryError,
      );
    });

    it('대상이 없으면 404다', async () => {
      const namespace = await createNamespace(`set-mimetype-missing-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const missing = encodeRevision({ id: randomUUID(), version: 1 });

      await expect(
        setMimeType(namespace.id, root.id, '/missing.bin', missing, 'image/png'),
      ).rejects.toBeInstanceOf(VfsNodeNotFoundError);
    });

    it('revision이 일치하지 않으면 412이고 current에 충돌 시점 mimeType이 담긴다', async () => {
      const namespace = await createNamespace(`set-mimetype-conflict-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['a.bin'],
        false,
        makeBlobData({ mimeType: 'text/plain' }),
        null,
        false,
      );
      const stale = encodeRevision({ id: created.node.id, version: created.node.version + 5 });

      const error = await setMimeType(namespace.id, root.id, '/a.bin', stale, 'image/png').catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(VfsPreconditionFailedError);
      expect((error as VfsPreconditionFailedError).current).toMatchObject({ mimeType: 'text/plain' });
    });

    it('만료 예정 FILE도 변경에 성공하고 expiresAt은 그대로 유지된다', async () => {
      const namespace = await createNamespace(`set-mimetype-expiring-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().putConditionalContent(
          tx,
          ['temp.bin'],
          { ifAbsent: true, expiresInSeconds: 600 },
          makeBlobData({ mimeType: 'text/plain' }),
        ),
      );
      const before = await getDs()
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ id: created.value.resource.id });
      expect(before.expiresAt).not.toBeNull();

      const result = await setMimeType(
        namespace.id,
        root.id,
        '/temp.bin',
        created.value.resource.revision,
        'image/png',
      );

      expect(result.value.status).toBe(200);
      const after = await getDs()
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ id: created.value.resource.id });
      expect(after.mimeType).toBe('image/png');
      expect(after.expiresAt!.toISOString()).toBe(before.expiresAt!.toISOString());
    });
  });
}
