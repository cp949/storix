import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';
import { NamespaceEntity } from '../../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import { encodeRevision } from '../../../src/vfs/revision.js';
import { expectCountersMatchRows } from '../vfs-counter-invariants.js';

/**
 * 폴더 FILE 수·namespace live node 수 counter 행렬(작업 checklist "Counter·제한 검사 행렬")을 검증한다.
 *
 * 모든 케이스는 변이 직후 저장 counter가 실제 행에서 다시 센 값과 같은지 확인한다.
 * 이 파일이 맡는 행은 touch·업로드, mkdir, copy·move, trash 복원, snapshot blob 복원,
 * 삭제·만료, 마지막 slot 동시 경쟁이다. backfill과 namespace 비동기 삭제는 각각 migration·cleanup 테스트가 맡는다.
 */
export function runCounterMatrixTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, runSameConditionAttempts, makeBlobData } = helpers;
  const UNLIMITED = Number.MAX_SAFE_INTEGER;

  async function fixture(name: string, settings: Partial<NamespaceEntity> = {}) {
    const namespace = await createNamespace(name);
    if (Object.keys(settings).length > 0) {
      await getDs().getRepository(NamespaceEntity).update({ id: namespace.id }, settings);
    }
    const root = (await getRepo().getRoot(namespace.id))!;
    return { namespaceId: namespace.id, rootId: root.id };
  }

  const check = (namespaceId: string) => expectCountersMatchRows(getDs(), namespaceId);

  describe('counter 행렬', () => {
    describe('touch·업로드', () => {
      it('새 FILE은 부모 FILE 수와 live node 수를 올리고 내용 교체는 그대로 둔다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-upload-ns');
        await getRepo().ensureDirectory(namespaceId, rootId, ['dir'], false);

        await getRepo().touchFile(namespaceId, rootId, ['dir', 'touched.txt'], false, makeBlobData());
        await check(namespaceId);
        await getRepo().touchFile(namespaceId, rootId, ['dir', 'touched.txt'], false, makeBlobData());
        await check(namespaceId);

        const created = await getRepo().putFileContent(
          namespaceId,
          rootId,
          ['dir', 'put.txt'],
          false,
          makeBlobData({ size: '3' }),
          null,
          false,
        );
        await check(namespaceId);
        await getRepo().putFileContent(
          namespaceId,
          rootId,
          ['dir', 'put.txt'],
          false,
          makeBlobData({ size: '5' }),
          created.node.version,
          false,
        );
        await check(namespaceId);

        const dir = await getRepo().resolvePath(namespaceId, rootId, ['dir']);
        const stored = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: dir!.id });
        expect(String(stored.childFileCount)).toBe('2');
      });

      it('조건부 content 업로드도 새 FILE만 counter를 올린다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-conditional-upload-ns');

        const created = await getRepo().withMutation(namespaceId, rootId, (tx) =>
          getRepo().putConditionalContent(tx, ['a.bin'], { ifAbsent: true }, makeBlobData({ size: '2' })),
        );
        expect(created.value.status).toBe(201);
        await check(namespaceId);
        const node = (await getRepo().resolvePath(namespaceId, rootId, ['a.bin']))!;
        const replaced = await getRepo().withMutation(namespaceId, rootId, (tx) =>
          getRepo().putConditionalContent(
            tx,
            ['a.bin'],
            { ifRevision: encodeRevision(node) },
            makeBlobData({ size: '4' }),
          ),
        );
        expect(replaced.value.status).toBe(200);
        await check(namespaceId);
      });

      it('실패한 업로드는 counter를 바꾸지 않는다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-upload-failure-ns', { maxFilesPerFolder: '1' });
        await getRepo().touchFile(namespaceId, rootId, ['first.txt'], false, makeBlobData());

        await expect(
          getRepo().putFileContent(namespaceId, rootId, ['second.txt'], false, makeBlobData(), null, false),
        ).rejects.toMatchObject({ code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED' });
        await expect(
          getRepo().putFileContent(namespaceId, rootId, ['first.txt'], false, makeBlobData(), 99, false),
        ).rejects.toMatchObject({ status: 409 });
        await check(namespaceId);
      });
    });

    describe('mkdir', () => {
      it('새 DIRECTORY와 parents로 만든 중간 DIRECTORY는 live node 수에 들어가고 FILE 수에는 들어가지 않는다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-mkdir-ns');

        await getRepo().ensureDirectory(namespaceId, rootId, ['a'], false);
        await check(namespaceId);
        await getRepo().ensureDirectory(namespaceId, rootId, ['a', 'b', 'c'], true);
        await check(namespaceId);
        // 이미 있는 DIRECTORY를 다시 요청하면 counter가 그대로여야 한다.
        await getRepo().ensureDirectory(namespaceId, rootId, ['a', 'b', 'c'], true);
        await check(namespaceId);
        await getRepo().touchFile(namespaceId, rootId, ['x', 'y', 'z.txt'], true, makeBlobData());
        await check(namespaceId);

        const stored = await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
        expect(String(stored.liveNodeCount)).toBe('6');
      });
    });

    describe('copy·move', () => {
      it('FILE copy는 목적 폴더 FILE 수와 live node 수를 올린다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-copy-file-ns');
        await getRepo().ensureDirectory(namespaceId, rootId, ['to'], false);
        await getRepo().putFileContent(
          namespaceId,
          rootId,
          ['src.txt'],
          false,
          makeBlobData({ size: '2' }),
          null,
          false,
        );

        await getRepo().copyNode(namespaceId, rootId, ['src.txt'], ['to', 'copy.txt'], false, UNLIMITED);

        await check(namespaceId);
      });

      it('DIRECTORY copy는 하위 node를 모두 새로 세고 폴더별 FILE 수를 복사본 쪽에 맞춘다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-copy-tree-ns');
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'one.txt'], true, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'sub', 'two.txt'], true, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'sub', 'three.txt'], true, makeBlobData());
        await check(namespaceId);

        await getRepo().copyNode(namespaceId, rootId, ['tree'], ['copy'], false, UNLIMITED);

        await check(namespaceId);
        const stored = await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
        expect(String(stored.liveNodeCount)).toBe('10');
      });

      it('FILE을 다른 부모로 move하면 출발 -1, 목적 +1이고 같은 폴더 rename은 0이다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-move-file-ns');
        await getRepo().ensureDirectory(namespaceId, rootId, ['from'], false);
        await getRepo().ensureDirectory(namespaceId, rootId, ['to'], false);
        await getRepo().touchFile(namespaceId, rootId, ['from', 'f.txt'], false, makeBlobData());

        await getRepo().moveNode(namespaceId, rootId, ['from', 'f.txt'], ['to', 'f.txt'], false);
        await check(namespaceId);
        await getRepo().moveNode(namespaceId, rootId, ['to', 'f.txt'], ['to', 'renamed.txt'], false);
        await check(namespaceId);

        const to = await getRepo().resolvePath(namespaceId, rootId, ['to']);
        const from = await getRepo().resolvePath(namespaceId, rootId, ['from']);
        const nodes = getDs().getRepository(VfsNodeEntity);
        expect(String((await nodes.findOneByOrFail({ id: to!.id })).childFileCount)).toBe('1');
        expect(String((await nodes.findOneByOrFail({ id: from!.id })).childFileCount)).toBe('0');
      });

      it('DIRECTORY move는 하위 counter를 그대로 유지한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-move-tree-ns');
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'sub', 'a.txt'], true, makeBlobData());
        await getRepo().ensureDirectory(namespaceId, rootId, ['dest'], false);

        await getRepo().moveNode(namespaceId, rootId, ['tree'], ['dest', 'tree'], false);

        await check(namespaceId);
      });

      it('상한을 넘는 copy와 move는 counter를 바꾸지 않고 rollback한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-copy-move-limit-ns', {
          maxFilesPerFolder: '1',
        });
        await getRepo().touchFile(namespaceId, rootId, ['a', 'one.txt'], true, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['b', 'two.txt'], true, makeBlobData());

        await expect(
          getRepo().copyNode(namespaceId, rootId, ['a', 'one.txt'], ['b', 'copy.txt'], false, UNLIMITED),
        ).rejects.toMatchObject({ code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED' });
        await expect(
          getRepo().moveNode(namespaceId, rootId, ['a', 'one.txt'], ['b', 'one.txt'], false),
        ).rejects.toMatchObject({ code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED' });

        await check(namespaceId);
        expect(await getRepo().resolvePath(namespaceId, rootId, ['a', 'one.txt'])).not.toBeNull();
      });
    });

    describe('삭제·복원', () => {
      it('trash 비활성 영구 삭제는 FILE과 하위 tree를 counter에서 뺀다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-delete-ns');
        await getRepo().touchFile(namespaceId, rootId, ['top.txt'], false, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'sub', 'a.txt'], true, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'b.txt'], true, makeBlobData());

        await getRepo().removeNode(namespaceId, rootId, ['top.txt'], false, UNLIMITED);
        await check(namespaceId);
        await getRepo().removeNode(namespaceId, rootId, ['tree'], true, UNLIMITED);
        await check(namespaceId);

        const stored = await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
        expect(String(stored.liveNodeCount)).toBe('0');
      });

      it('휴지통 이동은 live counter를 빼고 복원은 정확히 한 번 더한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-trash-restore-ns', { trashEnabled: true });
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'sub', 'a.txt'], true, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'b.txt'], true, makeBlobData());
        const trashId = await getRepo().removeNode(namespaceId, rootId, ['tree'], true, UNLIMITED);
        expect(trashId).not.toBeNull();
        await check(namespaceId);
        expect(
          String(
            (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId })).liveNodeCount,
          ),
        ).toBe('0');

        await getRepo().restoreTrashItem(namespaceId, trashId!);

        await check(namespaceId);
        expect(
          String(
            (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId })).liveNodeCount,
          ),
        ).toBe('4');
      });

      it('휴지통 purge는 live counter를 바꾸지 않는다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-trash-purge-ns', { trashEnabled: true });
        await getRepo().touchFile(namespaceId, rootId, ['a.txt'], false, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['keep.txt'], false, makeBlobData());
        const trashId = await getRepo().removeNode(namespaceId, rootId, ['a.txt'], false, UNLIMITED);

        await getRepo().purgeTrashItem(namespaceId, trashId!);

        await check(namespaceId);
        expect(
          String(
            (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId })).liveNodeCount,
          ),
        ).toBe('1');
      });

      it('휴지통 복원이 하위 폴더의 FILE 상한에서 실패하면 복원한 node와 counter 전부 rollback한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-trash-restore-limit-ns', {
          trashEnabled: true,
          maxFilesPerFolder: '2',
        });
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'top.txt'], true, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'sub', 'a.txt'], true, makeBlobData());
        await getRepo().touchFile(namespaceId, rootId, ['tree', 'sub', 'b.txt'], true, makeBlobData());
        const trashId = await getRepo().removeNode(namespaceId, rootId, ['tree'], true, UNLIMITED);
        // 상한을 낮추면 sub 폴더 복원에서 초과한다. top.txt가 들어가는 tree 폴더는 상한 안이다.
        await getDs().getRepository(NamespaceEntity).update({ id: namespaceId }, { maxFilesPerFolder: '1' });

        await expect(getRepo().restoreTrashItem(namespaceId, trashId!)).rejects.toMatchObject({
          code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED',
        });

        await check(namespaceId);
        expect(await getRepo().resolvePath(namespaceId, rootId, ['tree'])).toBeNull();
        expect(
          String(
            (await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId })).liveNodeCount,
          ),
        ).toBe('0');
      });

      it('snapshot Blob 복원은 새 FILE만 counter를 올린다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-snapshot-restore-ns');
        await getRepo().putFileContent(
          namespaceId,
          rootId,
          ['source.bin'],
          false,
          makeBlobData({ size: '4' }),
          null,
          false,
        );
        const source = (await getRepo().resolvePath(namespaceId, rootId, ['source.bin']))!;
        const blob = { blobId: source.blobId!, size: String(source.size), mimeType: source.mimeType! };

        await getRepo().withMutation(namespaceId, rootId, (tx) =>
          getRepo().restoreBlob(tx, ['restored.bin'], { ifAbsent: true }, blob),
        );
        await check(namespaceId);
        const restored = (await getRepo().resolvePath(namespaceId, rootId, ['restored.bin']))!;
        await getRepo().withMutation(namespaceId, rootId, (tx) =>
          getRepo().restoreBlob(tx, ['restored.bin'], { ifRevision: encodeRevision(restored) }, blob),
        );
        await check(namespaceId);
      });

      it('만료된 FILE을 GC가 정리하면 counter에서 뺀다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-expire-ns');
        await getRepo().putFileContent(
          namespaceId,
          rootId,
          ['dir', 'expiring.txt'],
          true,
          makeBlobData({ size: '1' }),
          null,
          false,
          undefined,
          new Date(Date.now() - 60_000),
        );
        await getRepo().touchFile(namespaceId, rootId, ['dir', 'keep.txt'], false, makeBlobData());
        const expiring = (await getRepo().resolvePath(namespaceId, rootId, ['dir', 'expiring.txt']))!;

        const result = await getRepo().expireNode(namespaceId, expiring.id, new Date());

        expect(result).not.toBeNull();
        await check(namespaceId);
        expect(await getRepo().resolvePath(namespaceId, rootId, ['dir', 'expiring.txt'])).toBeNull();
      });
    });

    describe('기존 초과 상태', () => {
      it('상한을 낮춰 폴더가 초과돼도 줄이는 요청은 허용하고 늘리는 요청만 거부한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-over-folder-ns');
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
          await getRepo().touchFile(namespaceId, rootId, ['d', name], true, makeBlobData());
        }
        await getDs().getRepository(NamespaceEntity).update({ id: namespaceId }, { maxFilesPerFolder: '1' });

        // 개수가 변하지 않는 요청: 내용 교체와 같은 폴더 안 이름 변경
        const replaced = await getRepo().touchFile(
          namespaceId,
          rootId,
          ['d', 'a.txt'],
          false,
          makeBlobData(),
        );
        expect(replaced.kind).toBe('replaced');
        await getRepo().moveNode(namespaceId, rootId, ['d', 'a.txt'], ['d', 'renamed.txt'], false);
        await check(namespaceId);

        // 늘리는 요청: 초과 폴더에 새 FILE, 초과 폴더로 이동은 거부
        await expect(
          getRepo().touchFile(namespaceId, rootId, ['d', 'new.txt'], false, makeBlobData()),
        ).rejects.toMatchObject({ code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED' });
        await getRepo().touchFile(namespaceId, rootId, ['top.txt'], false, makeBlobData());
        await expect(
          getRepo().moveNode(namespaceId, rootId, ['top.txt'], ['d', 'top.txt'], false),
        ).rejects.toMatchObject({ code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED' });
        await check(namespaceId);

        // 줄이는 요청: 초과 폴더에서 삭제하거나 다른 폴더로 이동하면 허용
        await getRepo().removeNode(namespaceId, rootId, ['d', 'b.txt'], false, 100);
        await check(namespaceId);
        await getRepo().ensureDirectory(namespaceId, rootId, ['other'], false);
        await getRepo().moveNode(namespaceId, rootId, ['d', 'c.txt'], ['other', 'c.txt'], false);
        await check(namespaceId);

        const folder = await getRepo().resolvePath(namespaceId, rootId, ['d']);
        const stored = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: folder!.id });
        expect(String(stored.childFileCount)).toBe('1');
      });

      it('상한을 낮춰 namespace live node가 초과돼도 줄이는 요청은 허용하고 늘리는 요청만 거부한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-over-node-ns');
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
          await getRepo().touchFile(namespaceId, rootId, ['d', name], true, makeBlobData());
        }
        await getDs().getRepository(NamespaceEntity).update({ id: namespaceId }, { maxLiveNodes: '3' });

        // 개수가 변하지 않는 요청: 내용 교체와 이름 변경
        const replaced = await getRepo().touchFile(
          namespaceId,
          rootId,
          ['d', 'a.txt'],
          false,
          makeBlobData(),
        );
        expect(replaced.kind).toBe('replaced');
        await getRepo().moveNode(namespaceId, rootId, ['d', 'a.txt'], ['d', 'renamed.txt'], false);
        await check(namespaceId);

        // 늘리는 요청: 새 FILE·DIRECTORY, copy는 거부
        await expect(
          getRepo().touchFile(namespaceId, rootId, ['d', 'new.txt'], false, makeBlobData()),
        ).rejects.toMatchObject({ code: 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED' });
        await expect(getRepo().ensureDirectory(namespaceId, rootId, ['more'], false)).rejects.toMatchObject({
          code: 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED',
        });
        await expect(
          getRepo().copyNode(namespaceId, rootId, ['d', 'renamed.txt'], ['copy.txt'], false, UNLIMITED),
        ).rejects.toMatchObject({ code: 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED' });
        await check(namespaceId);

        // 줄이는 요청: 삭제는 허용한다. 상한에 닿은 동안은 늘리는 요청을 거부하고 아래로 내려가면 허용한다.
        await getRepo().removeNode(namespaceId, rootId, ['d', 'b.txt'], false, 100);
        await check(namespaceId);
        await expect(
          getRepo().touchFile(namespaceId, rootId, ['d', 'again.txt'], false, makeBlobData()),
        ).rejects.toMatchObject({ code: 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED' });
        await getRepo().removeNode(namespaceId, rootId, ['d', 'c.txt'], false, 100);
        await getRepo().touchFile(namespaceId, rootId, ['d', 'again.txt'], false, makeBlobData());
        await check(namespaceId);
        const stored = await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
        expect(String(stored.liveNodeCount)).toBe('3');
      });
    });

    describe('동시 요청', () => {
      it('namespace live node 마지막 slot을 두 요청이 다투면 하나만 성공한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-race-node-ns', { maxLiveNodes: '1' });
        let sequence = 0;

        const results = await runSameConditionAttempts(namespaceId, () =>
          getRepo().touchFile(namespaceId, rootId, [`race-${sequence++}.txt`], false, makeBlobData()),
        );

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED' });
        await check(namespaceId);
      });

      it('폴더 FILE 마지막 slot을 두 요청이 다투면 하나만 성공한다', async () => {
        const { namespaceId, rootId } = await fixture('matrix-race-folder-ns', { maxFilesPerFolder: '1' });
        let sequence = 0;

        const results = await runSameConditionAttempts(namespaceId, () =>
          getRepo().putFileContent(
            namespaceId,
            rootId,
            [`race-${sequence++}.txt`],
            false,
            makeBlobData(),
            null,
            false,
          ),
        );

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED' });
        await check(namespaceId);
      });
    });
  });
}
