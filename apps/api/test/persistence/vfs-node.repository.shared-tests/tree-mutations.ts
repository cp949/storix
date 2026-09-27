import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';
import { randomUUID } from 'node:crypto';
import { BlobEntity } from '../../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import {
  VfsAlreadyExistsError,
  VfsCopyLimitExceededError,
  VfsDeleteLimitExceededError,
  VfsInvalidOperationError,
  VfsInvalidPathError,
  VfsIsDirectoryError,
  VfsNodeNotFoundError,
} from '../../../src/vfs/vfs.errors.js';

export function runTreeMutationsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, createFile, captureState, makeBlobData } = helpers;
  describe('removeNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('FILE을 삭제하면 Blob 참조를 휴지통에 보존한다', async () => {
      const namespace = await createNamespace('rm-file-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');

      await getRepo().removeNode(namespace.id, root!.id, ['a.txt'], false, UNLIMITED);

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toBeNull();
      const blob = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });
      expect(blob.referenceCount).toBe(1);
      expect(blob.zeroSince).toBeNull();
    });

    it('recursive=false로 directory를 삭제하려 하면 VfsIsDirectoryError를 던진다', async () => {
      const namespace = await createNamespace('rm-dir-non-recursive-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(getRepo().removeNode(namespace.id, root!.id, ['a'], false, UNLIMITED)).rejects.toThrow(
        VfsIsDirectoryError,
      );
    });

    it('recursive=true면 하위 트리를 휴지통으로 옮기고 각 file의 Blob 참조를 보존한다', async () => {
      const namespace = await createNamespace('rm-recursive-ns');
      const root = await getRepo().getRoot(namespace.id);
      const a = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const c = await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'c'], false);
      const fileB = await createFile(namespace.id, a.node.id, 'b.txt');
      const fileD = await createFile(namespace.id, c.node.id, 'd.txt');

      await getRepo().removeNode(namespace.id, root!.id, ['a'], true, UNLIMITED);

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a'])).toBeNull();
      const blobRepo = getDs().getRepository(BlobEntity);
      const blobB = await blobRepo.findOneByOrFail({ id: fileB.blobId as string });
      const blobD = await blobRepo.findOneByOrFail({ id: fileD.blobId as string });
      expect(blobB.referenceCount).toBe(1);
      expect(blobB.zeroSince).toBeNull();
      expect(blobD.referenceCount).toBe(1);
      expect(blobD.zeroSince).toBeNull();
    });

    it('같은 Blob을 여러 Node가 참조하면 recursive delete가 감소량을 합산한다', async () => {
      const namespace = await createNamespace('rm-shared-blob-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const nodeRepo = getDs().getRepository(VfsNodeEntity);
      const blobRepo = getDs().getRepository(BlobEntity);
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

      await getRepo().removeNode(namespace.id, root!.id, ['a'], true, UNLIMITED);

      expect((await blobRepo.findOneByOrFail({ id: sharedBlob.id })).referenceCount).toBe(2);
    });

    it('존재하지 않는 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('rm-missing-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().removeNode(namespace.id, root!.id, ['missing.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('STORIX_MAX_SYNC_DELETE_NODES를 넘으면 작업 시작 전에 VfsDeleteLimitExceededError를 던지고 아무것도 삭제하지 않는다', async () => {
      const namespace = await createNamespace('rm-limit-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['big'], false);
      await createFile(namespace.id, dir.node.id, '1.txt');
      await createFile(namespace.id, dir.node.id, '2.txt');
      await createFile(namespace.id, dir.node.id, '3.txt');
      // dir 자신 포함 4개 Node > 상한 2

      await expect(getRepo().removeNode(namespace.id, root!.id, ['big'], true, 2)).rejects.toThrow(
        VfsDeleteLimitExceededError,
      );

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['big'])).not.toBeNull();
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['big', '1.txt'])).not.toBeNull();
    });
  });

  describe('copyNode', () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;

    it('COW: source와 같은 blob을 참조하는 새 Node를 만들고 reference_count를 늘린다', async () => {
      const namespace = await createNamespace('cp-cow-ns');
      const root = await getRepo().getRoot(namespace.id);
      const source = await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED);

      expect(result).toMatchObject({ finalPath: '/b.txt', node: { name: 'b.txt', blobId: source.blobId } });
      const blob = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: source.blobId as string });
      expect(blob.referenceCount).toBe(2);
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toMatchObject({
        blobId: source.blobId,
      });
    });

    it('목적지가 기존 디렉터리면 source basename 아래로 배치한다', async () => {
      const namespace = await createNamespace('cp-nest-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['dest'], false);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['dest'], false, UNLIMITED);

      expect(result.finalPath).toBe('/dest/a.txt');
    });

    it('destinationParents=true면 누락된 목적지 중간 디렉터리를 원자적으로 생성한다', async () => {
      const namespace = await createNamespace('cp-parents-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      const result = await getRepo().copyNode(
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
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['x', 'a.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('목적지 경로에 이미 파일이 있으면 VfsAlreadyExistsError를 던진다', async () => {
      const namespace = await createNamespace('cp-conflict-ns');
      const root = await getRepo().getRoot(namespace.id);
      await createFile(namespace.id, root!.id, 'a.txt');
      await createFile(namespace.id, root!.id, 'b.txt');

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsAlreadyExistsError);
    });

    it('디렉터리를 자기 자신 아래로 복사하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('cp-self-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a'], ['a'], false, UNLIMITED),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('디렉터리를 자기 subtree 아래로 복사하면 VfsInvalidOperationError를 던진다', async () => {
      const namespace = await createNamespace('cp-subtree-ns');
      const root = await getRepo().getRoot(namespace.id);
      await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'b'], true);

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['a'], ['a', 'b'], false, UNLIMITED),
      ).rejects.toThrow(VfsInvalidOperationError);
    });

    it('recursive: 하위 트리를 전부 복사하고 각 file의 Blob reference_count를 늘린다', async () => {
      const namespace = await createNamespace('cp-recursive-ns');
      const root = await getRepo().getRoot(namespace.id);
      const a = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const c = await getRepo().ensureDirectory(namespace.id, root!.id, ['a', 'c'], false);
      const fileB = await createFile(namespace.id, a.node.id, 'b.txt');
      const fileD = await createFile(namespace.id, c.node.id, 'd.txt');

      const result = await getRepo().copyNode(namespace.id, root!.id, ['a'], ['a2'], false, UNLIMITED);

      expect(result.finalPath).toBe('/a2');
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a2', 'b.txt'])).toMatchObject({
        blobId: fileB.blobId,
      });
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a2', 'c', 'd.txt'])).toMatchObject({
        blobId: fileD.blobId,
      });
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a', 'b.txt'])).not.toBeNull();
      const blobRepo = getDs().getRepository(BlobEntity);
      expect((await blobRepo.findOneByOrFail({ id: fileB.blobId as string })).referenceCount).toBe(2);
      expect((await blobRepo.findOneByOrFail({ id: fileD.blobId as string })).referenceCount).toBe(2);
    });

    it('같은 Blob을 여러 Node가 참조하는 subtree를 복사하면 증가량을 합산한다', async () => {
      const namespace = await createNamespace('cp-shared-blob-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['a'], false);
      const nodeRepo = getDs().getRepository(VfsNodeEntity);
      const blobRepo = getDs().getRepository(BlobEntity);
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

      await getRepo().copyNode(namespace.id, root!.id, ['a'], ['a2'], false, UNLIMITED);

      expect((await blobRepo.findOneByOrFail({ id: sharedBlob.id })).referenceCount).toBe(4);
    });

    it('write-after-copy: 복사된 Node를 write하면 새 Blob으로 교체되고 원본은 영향받지 않는다', async () => {
      const namespace = await createNamespace('cp-detach-ns');
      const root = await getRepo().getRoot(namespace.id);
      const source = await createFile(namespace.id, root!.id, 'a.txt');

      await getRepo().copyNode(namespace.id, root!.id, ['a.txt'], ['b.txt'], false, UNLIMITED);
      const sharedBlobId = source.blobId as string;
      const copied = await getRepo().resolvePath(namespace.id, root!.id, ['b.txt']);

      const outcome = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['b.txt'],
        false,
        makeBlobData({ size: '9' }),
        copied!.version,
        false,
      );

      expect(outcome).toMatchObject({ kind: 'replaced', node: { size: '9' } });
      const blobRepo = getDs().getRepository(BlobEntity);
      const shared = await blobRepo.findOneByOrFail({ id: sharedBlobId });
      expect(shared.referenceCount).toBe(1);
      expect(await getRepo().resolvePath(namespace.id, root!.id, ['a.txt'])).toMatchObject({
        blobId: sharedBlobId,
      });
      const b = await getRepo().resolvePath(namespace.id, root!.id, ['b.txt']);
      expect(b!.blobId).not.toBe(sharedBlobId);
    });

    it('독립적으로 업로드한 동일 content는 deduplicate하지 않는다', async () => {
      const namespace = await createNamespace('cp-no-dedup-ns');
      const root = await getRepo().getRoot(namespace.id);
      const sha256 = '1'.repeat(64);

      const first = await getRepo().putFileContent(
        namespace.id,
        root!.id,
        ['a.txt'],
        false,
        makeBlobData({ sha256 }),
        null,
        false,
      );
      const second = await getRepo().putFileContent(
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
      const aNode = await getRepo().resolvePath(namespace.id, root!.id, ['a.txt']);
      const bNode = await getRepo().resolvePath(namespace.id, root!.id, ['b.txt']);
      expect(aNode!.blobId).not.toBe(bNode!.blobId);
    });

    it('존재하지 않는 source 경로는 VfsNodeNotFoundError를 던진다', async () => {
      const namespace = await createNamespace('cp-missing-source-ns');
      const root = await getRepo().getRoot(namespace.id);

      await expect(
        getRepo().copyNode(namespace.id, root!.id, ['missing.txt'], ['x.txt'], false, UNLIMITED),
      ).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('STORIX_MAX_SYNC_COPY_NODES를 넘으면 작업 시작 전에 VfsCopyLimitExceededError를 던지고 아무것도 만들지 않는다', async () => {
      const namespace = await createNamespace('cp-limit-ns');
      const root = await getRepo().getRoot(namespace.id);
      const dir = await getRepo().ensureDirectory(namespace.id, root!.id, ['big'], false);
      await createFile(namespace.id, dir.node.id, '1.txt');
      await createFile(namespace.id, dir.node.id, '2.txt');
      await createFile(namespace.id, dir.node.id, '3.txt');
      // dir 자신 포함 4개 Node > 상한 2

      await expect(getRepo().copyNode(namespace.id, root!.id, ['big'], ['copy'], false, 2)).rejects.toThrow(
        VfsCopyLimitExceededError,
      );

      expect(await getRepo().resolvePath(namespace.id, root!.id, ['copy'])).toBeNull();
    });
  });

  describe('결과 경로 길이', () => {
    it('기존 디렉터리에 basename을 붙인 이동 결과가 4096바이트를 넘으면 무변경이다', async () => {
      const namespace = await createNamespace('move-result-path-limit-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(254)] as string[];
      expect(Buffer.byteLength(`/${destination.join('/')}/a`, 'utf8')).toBe(4097);
      await getRepo().ensureDirectory(namespace.id, root.id, destination, true);
      await createFile(namespace.id, root.id, 'a');
      const before = await captureState(namespace.id);

      await expect(getRepo().moveNode(namespace.id, root.id, ['a'], destination, false)).rejects.toThrow(
        VfsInvalidPathError,
      );
      expect(await captureState(namespace.id)).toEqual(before);
    });

    it('디렉터리 자식의 복사 결과만 한도를 넘고 부모를 자동 생성해도 전체가 무변경이다', async () => {
      const namespace = await createNamespace('copy-child-path-limit-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = await getRepo().ensureDirectory(namespace.id, root.id, ['s'], false);
      await createFile(namespace.id, source.node.id, 'x');
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(253), 's'] as string[];
      expect(Buffer.byteLength(`/${destination.join('/')}`, 'utf8')).toBe(4096);
      expect(Buffer.byteLength(`/${destination.join('/')}/x`, 'utf8')).toBe(4098);
      const before = await captureState(namespace.id);

      await expect(getRepo().copyNode(namespace.id, root.id, ['s'], destination, true, 1000)).rejects.toThrow(
        VfsInvalidPathError,
      );
      expect(await captureState(namespace.id)).toEqual(before);
    });

    it('디렉터리 이동에서 자식 경로만 초과해도 무변경이다', async () => {
      const namespace = await createNamespace('move-child-path-limit-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const source = await getRepo().ensureDirectory(namespace.id, root.id, ['s'], false);
      await createFile(namespace.id, source.node.id, 'x');
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(253)] as string[];
      await getRepo().ensureDirectory(namespace.id, root.id, destination, true);
      const before = await captureState(namespace.id);

      await expect(getRepo().moveNode(namespace.id, root.id, ['s'], destination, false)).rejects.toThrow(
        VfsInvalidPathError,
      );
      expect(await captureState(namespace.id)).toEqual(before);
    });

    it('결과 경로가 정확히 4096바이트인 이동은 허용한다', async () => {
      const namespace = await createNamespace('move-path-limit-boundary-ns');
      const root = (await getRepo().getRoot(namespace.id))!;
      const destination = [...Array(15).fill('a'.repeat(255)), 'a'.repeat(253)] as string[];
      await getRepo().ensureDirectory(namespace.id, root.id, destination, true);
      await createFile(namespace.id, root.id, 'a');

      const result = await getRepo().moveNode(namespace.id, root.id, ['a'], destination, false);
      expect(Buffer.byteLength(result.finalPath, 'utf8')).toBe(4096);
      expect(await getRepo().resolvePath(namespace.id, root.id, [...destination, 'a'])).not.toBeNull();
    });
  });

  describe('getBlobStorageInfo', () => {
    it('존재하는 blob의 storage key와 encryptionIv를 반환한다', async () => {
      const namespace = await createNamespace('blob-key-ns');
      const root = await getRepo().getRoot(namespace.id);
      const file = await createFile(namespace.id, root!.id, 'a.txt');
      const expected = await getDs()
        .getRepository(BlobEntity)
        .findOneByOrFail({ id: file.blobId as string });

      const info = await getRepo().getBlobStorageInfo(namespace.id, file.blobId as string);

      expect(info).toEqual({ storageKey: expected.storageKey, encryptionIv: expected.encryptionIv });
    });

    it('존재하지 않는 blobId는 null을 반환한다', async () => {
      const namespace = await createNamespace('blob-key-missing-ns');

      const info = await getRepo().getBlobStorageInfo(namespace.id, randomUUID());

      expect(info).toBeNull();
    });
  });
}
