import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';
import { BlobEntity } from '../../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import {
  VfsAlreadyExistsError,
  VfsDirectoryNotEmptyError,
  VfsInvalidOperationError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
  VfsVersionConflictError,
} from '../../../src/vfs/vfs.errors.js';

export function runFileMutationsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, createFile, makeBlobData } = helpers;
  describe('touchFile', () => {
    it('namespace live node 상한을 초과하는 생성을 거부하고 counter를 유지한다', async () => {
      const namespace = await createNamespace('touch-live-node-limit-ns');
      await getDs().getRepository(NamespaceEntity).update({ id: namespace.id }, { maxLiveNodes: '1' });
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['directory'], false);

      await expect(
        getRepo().touchFile(namespace.id, root!.id, ['file.txt'], false, makeBlobData()),
      ).rejects.toMatchObject({ code: 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED', status: 413 });
      const stored = await getDs().getRepository(NamespaceEntity).findOneByOrFail({ id: namespace.id });
      expect(String(stored.liveNodeCount)).toBe('1');
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['file.txt'])).toBeNull();
    });

    it('폴더 직접 자식 FILE 상한 초과를 거부하고 counter를 유지한다', async () => {
      const namespace = await createNamespace('touch-folder-limit-ns');
      await getDs().getRepository(NamespaceEntity).update({ id: namespace.id }, { maxFilesPerFolder: '1' });
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().touchFile(namespace.id, root!.id, ['first.txt'], false, makeBlobData());

      await expect(
        getRepo().touchFile(namespace.id, root!.id, ['second.txt'], false, makeBlobData()),
      ).rejects.toMatchObject({ code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED', status: 413 });
      const storedRoot = await getDs().getRepository(VfsNodeEntity).findOneByOrFail({ id: root!.id });
      expect(String(storedRoot.childFileCount)).toBe('1');
    });

    it('대상이 없으면 0-byte file을 생성하고 created를 반환한다', async () => {
      const namespace = await createNamespace('touch-create-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a.txt'], false, makeBlobData());

      expect(result).toMatchObject({ kind: 'created', node: { name: 'a.txt', type: 'FILE', size: '0' } });
    });

    it('대상 file이 있으면 content는 유지한 채 version만 올린다', async () => {
      const namespace = await createNamespace('touch-existing-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a.txt'], false, makeBlobData());

      expect(result.kind).toBe('replaced');
      expect(result.node.blobId).toBe(file.blobId);
      expect(result.node.version).toBe(file.version + 1);
    });

    it('blob 없이 호출하면 기존 file의 content는 유지한 채 version만 올린다', async () => {
      const namespace = await createNamespace('touch-null-blob-existing-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a.txt'], false, null);

      expect(result.kind).toBe('replaced');
      if (result.kind !== 'replaced') return;
      expect(result.node.blobId).toBe(file.blobId);
      expect(result.node.version).toBe(file.version + 1);
    });

    it('blob 없이 호출했는데 대상이 없으면 absent를 반환하고 아무것도 만들지 않는다', async () => {
      const namespace = await createNamespace('touch-null-blob-absent-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a.txt'], false, null);

      expect(result).toEqual({ kind: 'absent' });
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toBeNull();
      expect(await getDs().getRepository(BlobEntity).countBy({ namespaceId: namespace.id })).toBe(0);
    });

    it('blob 없이 호출해도 대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('touch-null-blob-dir-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['adir'], false);

      await expect(getRepo().touchFile(namespace.id, root!.id, ['adir'], false, null)).rejects.toThrow(
        VfsIsDirectoryError,
      );
    });

    it('대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('touch-dir-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['adir'], false);

      await expect(
        getRepo().touchFile(namespace.id, root!.id, ['adir'], false, makeBlobData()),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('parents=true면 중간 디렉터리를 만들며 file을 생성한다', async () => {
      const namespace = await createNamespace('touch-parents-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().touchFile(namespace.id, root!.id, ['a', 'b.txt'], true, makeBlobData());

      expect(result).toMatchObject({ kind: 'created', node: { name: 'b.txt', type: 'FILE' } });
    });

    it('parents=false로 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('touch-no-parent-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().touchFile(namespace.id, root!.id, ['a', 'b.txt'], false, makeBlobData()),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });
  });

  describe('putFileContent', () => {
    it('대상이 없으면 새 file을 생성한다', async () => {
      const namespace = await createNamespace('put-create-ns');
      const root = await getRepo().getRoot(namespace.id);

      const result = await getRepo().putFileContent(
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
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['adir'], false);

      await expect(
        getRepo().putFileContent(namespace.id, root!.id, ['adir'], false, makeBlobData(), null, false),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('If-Match version이 일치하면 새 Blob으로 교체하고 이전 Blob 참조를 줄인다', async () => {
      const namespace = await createNamespace('put-match-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().putFileContent(
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

      const oldBlob = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });
      expect(oldBlob.referenceCount).toBe(0);
      expect(oldBlob.zeroSince).not.toBeNull();
    });

    it('If-Match version이 불일치하면 VfsVersionConflictError를 던진다', async () => {
      const namespace = await createNamespace('put-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().putFileContent(
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
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().putFileContent(namespace.id, root!.id, ['a.txt'], false, makeBlobData(), null, false),
      ).rejects.toThrow(VfsVersionConflictError);
    });

    it('force=true면 If-Match 없이도 덮어쓴다', async () => {
      const namespace = await createNamespace('put-force-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().putFileContent(
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

    it('If-Match가 있는데 대상이 없으면 VfsVersionConflictError를 던지고 아무것도 만들지 않는다', async () => {
      const namespace = await createNamespace('put-missing-if-match-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().putFileContent(namespace.id, root!.id, ['gone.txt'], false, makeBlobData(), 3, false),
      ).rejects.toThrow(VfsVersionConflictError);

      await expect(getRepo().resolvePath(namespace.id, root!.id, ['gone.txt'])).resolves.toBeNull();
    });

    it('If-Match가 있는데 대상이 없으면 parents=true여도 상위 디렉터리를 만들지 않는다', async () => {
      const namespace = await createNamespace('put-missing-if-match-parents-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().putFileContent(
          namespace.id,
          root!.id,
          ['newdir', 'gone.txt'],
          true,
          makeBlobData(),
          3,
          false,
        ),
      ).rejects.toThrow(VfsVersionConflictError);

      await expect(getRepo().resolvePath(namespace.id, root!.id, ['newdir'])).resolves.toBeNull();
    });

    it('force=true여도 If-Match가 현재 version과 다르면 VfsVersionConflictError를 던진다', async () => {
      const namespace = await createNamespace('put-force-mismatch-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().putFileContent(
          namespace.id,
          root!.id,
          ['a.txt'],
          false,
          makeBlobData(),
          file.version + 1,
          true,
        ),
      ).rejects.toThrow(VfsVersionConflictError);
    });

    it('force=true이고 If-Match가 현재 version과 같으면 덮어쓴다', async () => {
      const namespace = await createNamespace('put-force-match-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ size: '4' }),
        file.version,
        true,
      );

      expect(result).toMatchObject({ kind: 'replaced', node: { size: '4' } });
    });
  });

  describe('moveNode', () => {
    it('같은 디렉터리 내에서 이름을 바꾼다', async () => {
      const namespace = await createNamespace('move-rename-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().moveNode(
        namespace.id,
        root!.id,
        ['a.txt'],
        ['b.txt'],
        false,
        Number.MAX_SAFE_INTEGER,
      );

      expect(result).toMatchObject({ finalPath: '/b.txt', node: { name: 'b.txt' } });
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toBeNull();
    });

    it('목적지가 기존 디렉터리면 source basename 아래로 배치한다', async () => {
      const namespace = await createNamespace('move-nest-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().moveNode(
        namespace.id,
        root!.id,
        ['a.txt'],
        ['dest'],
        false,
        Number.MAX_SAFE_INTEGER,
      );

      expect(result.finalPath).toBe('/dest/a.txt');
      const moved = await getRepo().resolvePath(namespace.id, root!.id, ['dest', 'a.txt']);
      expect(moved).toMatchObject({ name: 'a.txt' });
    });

    it('destinationParents=true면 누락된 목적지 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('move-parents-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().moveNode(
        namespace.id,
        root!.id,
        ['a.txt'],
        ['x', 'y', 'a.txt'],
        true,
        Number.MAX_SAFE_INTEGER,
      );

      expect(result.finalPath).toBe('/x/y/a.txt');
      const dir = await getRepo().resolvePath(namespace.id, root!.id, ['x', 'y']);
      expect(dir).toMatchObject({ type: 'DIRECTORY' });
    });

    it('destinationParents=false로 목적지 중간 디렉터리가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('move-no-parents-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['x', 'a.txt'], false, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('목적지 경로에 이미 file이 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'b.txt');

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow(VfsAlreadyExistsError);
    });

    it('목적지 디렉터리 아래 동일 이름이 이미 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-nest-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dest = await getRepo().ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, dest.node.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['dest'], false, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow(VfsAlreadyExistsError);
    });

    it('디렉터리를 자기 자신 아래로 move하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('move-self-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['a'], ['a'], false, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('디렉터리를 자기 subtree 아래로 move하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('move-subtree-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b'], true);

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['a'], ['a', 'b'], false, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('file을 정확히 같은 경로로 move하면 자신과 충돌해 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('move-file-self-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().moveNode(namespace.id, root!.id, ['a.txt'], ['a.txt'], false, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow(VfsAlreadyExistsError);
    });

    it('존재하지 않는 source 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('move-missing-source-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().moveNode(
          namespace.id,
          root!.id,
          ['missing.txt'],
          ['x.txt'],
          false,
          Number.MAX_SAFE_INTEGER,
        ),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });
  });

  describe('removeEmptyDirectory', () => {
    it('빈 디렉터리를 삭제한다', async () => {
      const namespace = await createNamespace('rmdir-empty-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await getRepo().removeEmptyDirectory(namespace.id, root!.id, ['a']);

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a'])).toBeNull();
    });

    it('비어 있지 않은 디렉터리는 VfsDirectoryNotEmptyError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-nonempty-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      await createFile(namespace.id, dir.node.id, 'x.txt');

      await expect(getRepo().removeEmptyDirectory(namespace.id, root!.id, ['a'])).rejects.toThrow(
        VfsDirectoryNotEmptyError,
      );
    });

    it('FILE 대상이면 VfsNotDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(getRepo().removeEmptyDirectory(namespace.id, root!.id, ['a.txt'])).rejects.toThrow(
        VfsNotDirectoryError,
      );
    });

    it('존재하지 않는 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('rmdir-missing-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(getRepo().removeEmptyDirectory(namespace.id, root!.id, ['missing'])).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });
  });
}
