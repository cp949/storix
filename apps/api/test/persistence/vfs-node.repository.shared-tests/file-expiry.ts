import { randomUUID } from 'node:crypto';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import { readDbNow } from '../../../src/persistence/vfs-node.repository.helpers.js';
import { encodeRevision } from '../../../src/vfs/revision.js';
import {
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsPreconditionFailedError,
} from '../../../src/vfs/vfs.errors.js';
import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';

export function runFileExpiryTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, makeBlobData } = helpers;

  describe('파일 만료', () => {
    async function createExpiring(namespaceId: string, rootId: string, name: string) {
      const created = await getRepo().withMutation(namespaceId, rootId, (tx) =>
        getRepo().putConditionalContent(
          tx,
          [name],
          { ifAbsent: true, expiresInSeconds: 600 },
          makeBlobData(),
        ),
      );
      return created.value.resource;
    }

    const persist = (namespaceId: string, rootId: string, path: string, ifRevision: string) =>
      getRepo().withMutation(namespaceId, rootId, (tx) =>
        getRepo().applyConditionalMutation(tx, {
          kind: 'persist',
          path,
          segments: path.split('/').filter(Boolean),
          ifRevision,
        }),
      );

    const copy = (
      namespaceId: string,
      rootId: string,
      source: string,
      destination: string,
      revision: string,
      expiresInSeconds?: number,
    ) =>
      getRepo().withMutation(namespaceId, rootId, (tx) =>
        getRepo().applyConditionalMutation(tx, {
          kind: 'copy',
          source,
          sourceSegments: source.split('/').filter(Boolean),
          destination,
          destinationSegments: destination.split('/').filter(Boolean),
          sourceRevision: revision,
          destinationAbsent: true,
          destinationResolution: 'exact',
          ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        }),
      );

    it('파일 copy에 만료를 주면 복사본만 DB 시각 + 초로 만료되고 원본은 그대로다', async () => {
      const namespace = await createNamespace(`copy-expiry-file-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['plain.bin'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const before = await readDbNow(getDs().manager);

      const copied = await copy(
        namespace.id,
        root.id,
        '/plain.bin',
        '/copy.bin',
        encodeRevision(source.node),
        600,
      );

      const nodes = getDs().getRepository(VfsNodeEntity);
      const stored = await nodes.findOneByOrFail({ id: copied.value.resource!.id });
      expect(stored.expiresAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 600_000 - 1000);
      expect(copied.value.resource!.expiresAt).toBe(stored.expiresAt!.toISOString());
      expect((await nodes.findOneByOrFail({ id: source.node.id })).expiresAt).toBeNull();
    });

    it('디렉터리 copy에 만료를 주면 새 FILE 전부에 같은 시각을 적용하고 새 DIRECTORY는 NULL이다', async () => {
      const namespace = await createNamespace(`copy-expiry-dir-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const dir = await getRepo().ensureDirectory(namespace.id, root.id, ['src'], false);
      await getRepo().ensureDirectory(namespace.id, root.id, ['src', 'sub'], false);
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['src', 'a.bin'],
        false,
        makeBlobData(),
        null,
        false,
      );
      await getRepo().putFileContent(
        namespace.id,
        root.id,
        ['src', 'sub', 'b.bin'],
        false,
        makeBlobData(),
        null,
        false,
      );
      const current = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: dir.node.id });

      const copied = await copy(namespace.id, root.id, '/src', '/dst', encodeRevision(current), 600);

      const rows = (await getRepo().findRecursive(namespace.id, copied.value.resource!.id, {}, null, 10)).map(
        (row) => [row.type, row.name, row.expiresAt?.toISOString() ?? null],
      );
      const fileTimes = rows.filter(([type]) => type === 'FILE').map(([, , time]) => time);
      expect(fileTimes).toHaveLength(2);
      expect(new Set(fileTimes).size).toBe(1);
      expect(fileTimes[0]).not.toBeNull();
      expect(rows.filter(([type]) => type === 'DIRECTORY').map(([, , time]) => time)).toEqual([null]);
      expect(copied.value.resource!.expiresAt).toBeNull();
    });

    it('만료 입력 없는 copy는 원본이 만료 예정이어도 만료 없는 복사본을 만든다', async () => {
      const namespace = await createNamespace(`copy-expiry-none-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const resource = await createExpiring(namespace.id, root.id, 'temp.bin');

      const copied = await copy(namespace.id, root.id, '/temp.bin', '/copy.bin', resource.revision);

      expect(copied.value.resource!.expiresAt).toBeNull();
    });

    it('persist는 만료를 해제하고 revision을 한 번 올리며 change feed에 updated를 남긴다', async () => {
      const namespace = await createNamespace(`persist-ok-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const resource = await createExpiring(namespace.id, root.id, 'temp.bin');
      const checkpoint = await getRepo().createChangeFeedCheckpoint(namespace.id, root.id);

      const result = await persist(namespace.id, root.id, '/temp.bin', resource.revision);

      const stored = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: resource.id });
      expect(stored.expiresAt).toBeNull();
      expect(stored.version).toBe(resource.version + 1);
      expect(result.value).toMatchObject({ status: 200, resource: { id: resource.id, expiresAt: null } });
      expect(result.affectedRevisions).toContainEqual({
        path: '/temp.bin',
        revision: encodeRevision(stored),
      });
      const events = await getRepo().listChangeFeedEvents(namespace.id, checkpoint, 10);
      expect(events.map((event) => [event.kind, event.nodeId])).toEqual([['updated', resource.id]]);
    });

    it('이미 확정된 파일의 persist는 변경 없이 200이고 revision과 change feed를 유지한다', async () => {
      const namespace = await createNamespace(`persist-noop-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const resource = await createExpiring(namespace.id, root.id, 'temp.bin');
      await persist(namespace.id, root.id, '/temp.bin', resource.revision);
      const confirmed = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: resource.id });
      const checkpoint = await getRepo().createChangeFeedCheckpoint(namespace.id, root.id);

      const again = await persist(namespace.id, root.id, '/temp.bin', encodeRevision(confirmed));

      expect(again.value.status).toBe(200);
      expect(again.affectedRevisions).toEqual([]);
      expect((await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: resource.id })).version).toBe(
        confirmed.version,
      );
      expect(await getRepo().listChangeFeedEvents(namespace.id, checkpoint, 10)).toEqual([]);
    });

    it('만료 시각이 지났어도 GC 전이면 persist가 성공한다', async () => {
      const namespace = await createNamespace(`persist-overdue-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const resource = await createExpiring(namespace.id, root.id, 'temp.bin');
      await getDs()
        .getRepository(VfsNodeEntity)
        .update({ id: resource.id }, { expiresAt: new Date(Date.now() - 60_000) });
      const overdue = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: resource.id });

      await persist(namespace.id, root.id, '/temp.bin', encodeRevision(overdue));

      expect(
        (await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: resource.id })).expiresAt,
      ).toBeNull();
    });

    it('persist는 없는 대상 404, 디렉터리 409, revision 불일치 412다', async () => {
      const namespace = await createNamespace(`persist-errors-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const resource = await createExpiring(namespace.id, root.id, 'temp.bin');
      const dir = await getRepo().ensureDirectory(namespace.id, root.id, ['dir'], false);

      await expect(persist(namespace.id, root.id, '/missing.bin', resource.revision)).rejects.toBeInstanceOf(
        VfsNodeNotFoundError,
      );
      await expect(persist(namespace.id, root.id, '/dir', encodeRevision(dir.node))).rejects.toBeInstanceOf(
        VfsIsDirectoryError,
      );
      const stale = encodeRevision({ id: resource.id, version: resource.version + 5 });
      await expect(persist(namespace.id, root.id, '/temp.bin', stale)).rejects.toBeInstanceOf(
        VfsPreconditionFailedError,
      );
    });

    it('ifAbsent 생성은 DB 시각 + 초로 expires_at을 채우고 응답에 포함한다', async () => {
      const namespace = await createNamespace(`expiry-create-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const before = await readDbNow(getDs().manager);

      const created = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().putConditionalContent(
          tx,
          ['temp.bin'],
          { ifAbsent: true, expiresInSeconds: 600 },
          makeBlobData(),
        ),
      );

      const stored = await getDs()
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ id: created.value.resource.id });
      const after = await readDbNow(getDs().manager);
      expect(stored.expiresAt).not.toBeNull();
      // SQLite CURRENT_TIMESTAMP는 초 단위라 1초 오차를 허용한다.
      expect(stored.expiresAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 600_000 - 1000);
      expect(stored.expiresAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 600_000 + 1000);
      expect(created.value.resource.expiresAt).toBe(stored.expiresAt!.toISOString());
    });

    it('만료 입력 없는 ifAbsent 생성은 expires_at이 NULL이다', async () => {
      const namespace = await createNamespace(`expiry-none-${randomUUID()}`);
      const root = (await getRepo().getRoot(namespace.id))!;
      const created = await getRepo().withMutation(namespace.id, root.id, (tx) =>
        getRepo().putConditionalContent(tx, ['plain.bin'], { ifAbsent: true }, makeBlobData()),
      );
      expect(created.value.resource.expiresAt).toBeNull();
    });
  });
}
