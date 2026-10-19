// applyExtract의 overwrite·clean 커밋, node id 유지, 카운터, 종류 충돌, 한도, 원자성, 변경 feed를 두 DB에서 공용으로 검증한다.
// 규칙은 docs/design/17-file-extract.md "실행". 내부 호출 순서와 status 판정은 extract-commit.spec.ts가 DB 없이 고정한다.
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import type {
  ExtractCommitEntry,
  ExtractCommitPlan,
} from '../../src/persistence/vfs-node.repository.extract.js';
import type { BlobData } from '../../src/persistence/vfs-node.repository.types.js';
import { MAX_VFS_VERSION, encodeRevision } from '../../src/vfs/revision.js';
import { expectCountersMatchRows } from './vfs-counter-invariants.js';

/** 공용 시나리오가 필요로 하는 저장소와 연결이다. */
export interface ExtractCommitContext {
  readonly dataSource: DataSource;
  readonly repository: VfsNodeRepository;
}

/** 테스트용 Blob metadata. storage object는 만들지 않는다. */
export function blobOf(body: string): BlobData {
  return {
    storageKey: `blobs/extract/${randomUUID()}`,
    size: String(Buffer.byteLength(body)),
    mimeType: 'application/octet-stream',
    sha256: createHash('sha256').update(body).digest('hex'),
    encryptionIv: null,
  };
}

export function fileEntry(entryIndex: number, name: string, body: string): ExtractCommitEntry {
  return { entryIndex, name, segments: name.split('/'), type: 'FILE', blob: blobOf(body) };
}

export function dirEntry(entryIndex: number, name: string): ExtractCommitEntry {
  return { entryIndex, name, segments: name.split('/'), type: 'DIRECTORY', blob: null };
}

type NamespaceTuning = Partial<
  Pick<
    NamespaceEntity,
    | 'trashEnabled'
    | 'excludeTrashFromQuota'
    | 'maxFilesPerFolder'
    | 'maxLiveNodes'
    | 'maxTotalLogicalBytes'
    | 'maxRetainedTrashBytes'
  >
>;

export function runExtractCommitSharedTests(getContext: () => ExtractCommitContext): void {
  /** 독립 namespace와 root를 만든다. 한도 값은 지정한 것만 바꾼다. */
  async function createNamespace(tuning: NamespaceTuning = {}) {
    const { dataSource } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      randomUUID(),
      `extract-commit-${randomUUID()}`,
    );
    if (Object.keys(tuning).length > 0)
      await dataSource.getRepository(NamespaceEntity).update({ id: namespace.id }, tuning);
    const root = await dataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: namespace.id, parentId: IsNull() });
    return { namespaceId: namespace.id, rootId: root.id };
  }

  const seedDir = (namespaceId: string, rootId: string, path: string) =>
    getContext().repository.ensureDirectory(namespaceId, rootId, path.split('/').filter(Boolean), true);

  const seedFile = (namespaceId: string, rootId: string, path: string, body = 'x') =>
    getContext().repository.putFileContent(
      namespaceId,
      rootId,
      path.split('/').filter(Boolean),
      true,
      blobOf(body),
      null,
      true,
    );

  const nodeAt = (namespaceId: string, rootId: string, path: string) =>
    getContext().repository.resolvePath(namespaceId, rootId, path.split('/').filter(Boolean));

  /** FILE 크기를 문자열로 읽는다. SQLite는 bigint를 number로 돌려주므로 비교 전에 맞춘다. */
  const sizeAt = async (namespaceId: string, rootId: string, path: string) =>
    String((await nodeAt(namespaceId, rootId, path))!.size);

  const plan = (
    overrides: Partial<ExtractCommitPlan> & Pick<ExtractCommitPlan, 'entries'>,
  ): ExtractCommitPlan => ({
    destinationSegments: ['site'],
    mode: 'overwrite',
    maxSyncDeleteNodes: 1000,
    ...overrides,
  });

  const run = (namespaceId: string, rootId: string, commit: ExtractCommitPlan) =>
    getContext().repository.withMutation(namespaceId, rootId, (tx) =>
      getContext().repository.applyExtract(tx, commit),
    );

  /** 오류 후 비교할 전체 상태다. node·blob 참조·namespace 카운터를 포함한다. */
  async function stateOf(namespaceId: string) {
    const { dataSource } = getContext();
    const nodes = await dataSource
      .getRepository(VfsNodeEntity)
      .find({ where: { namespaceId }, order: { id: 'ASC' } });
    const blobs = await dataSource
      .getRepository(BlobEntity)
      .find({ where: { namespaceId }, order: { id: 'ASC' } });
    const namespace = await dataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
    return {
      nodes: nodes.map(({ id, parentId, name, version, blobId, childFileCount }) => ({
        id,
        parentId,
        name,
        version,
        blobId,
        childFileCount: String(childFileCount),
      })),
      blobs: blobs.map(({ id, referenceCount }) => ({ id, referenceCount })),
      counters: {
        liveNodeCount: String(namespace.liveNodeCount),
        liveFileByteCount: String(namespace.liveFileByteCount),
        retainedTrashNodeCount: String(namespace.retainedTrashNodeCount),
        retainedTrashByteCount: String(namespace.retainedTrashByteCount),
      },
    };
  }

  /**
   * 저장된 카운터가 행에서 다시 계산한 값과 같은지 확인한다.
   * 휴지통을 쓰지 않는 namespace는 Blob 참조 수가 FILE node 수와 같은지도 확인한다.
   */
  async function expectConsistent(namespaceId: string, options: { blobReferences?: boolean } = {}) {
    const { dataSource } = getContext();
    await expectCountersMatchRows(dataSource, namespaceId);
    const files = await dataSource.getRepository(VfsNodeEntity).findBy({ namespaceId, type: 'FILE' });
    const namespace = await dataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
    expect(String(namespace.liveFileByteCount)).toBe(
      files.reduce((sum, file) => sum + BigInt(String(file.size)), 0n).toString(),
    );
    if (options.blobReferences === false) return;
    const blobs = await dataSource.getRepository(BlobEntity).findBy({ namespaceId });
    for (const blob of blobs)
      expect({ id: blob.id, referenceCount: blob.referenceCount }).toEqual({
        id: blob.id,
        referenceCount: files.filter((file) => file.blobId === blob.id).length,
      });
  }

  describe('새 destination과 overwrite', () => {
    it('없던 destination은 201이고 FILE·빈 DIRECTORY·암시적 부모를 만든다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedDir(namespaceId, rootId, '/sites');
      const result = await run(
        namespaceId,
        rootId,
        plan({
          destinationSegments: ['sites', 'a'],
          entries: [
            fileEntry(0, 'index.html', '<html>'),
            dirEntry(1, 'empty'),
            fileEntry(2, 'img/deep/a.png', 'png'),
          ],
        }),
      );
      expect(result.value).toMatchObject({ status: 201, createdCount: 2, replacedCount: 0 });
      expect(await nodeAt(namespaceId, rootId, '/sites/a/empty')).toMatchObject({ type: 'DIRECTORY' });
      expect(await nodeAt(namespaceId, rootId, '/sites/a/img/deep')).toMatchObject({ type: 'DIRECTORY' });
      expect(await nodeAt(namespaceId, rootId, '/sites/a/img/deep/a.png')).toMatchObject({ type: 'FILE' });
      expect(await sizeAt(namespaceId, rootId, '/sites/a/img/deep/a.png')).toBe('3');
      expect(await sizeAt(namespaceId, rootId, '/sites/a/index.html')).toBe('6');
      await expectConsistent(namespaceId);
    });

    it('overwrite는 같은 경로 FILE의 id를 유지하고 version을 한 번 올리며 나머지 FILE은 남긴다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/index.html', 'old');
      await seedFile(namespaceId, rootId, '/site/keep.txt', 'keep');
      const before = (await nodeAt(namespaceId, rootId, '/site/index.html'))!;
      const beforeDestination = (await nodeAt(namespaceId, rootId, '/site'))!;
      const result = await run(namespaceId, rootId, plan({ entries: [fileEntry(0, 'index.html', 'new!')] }));
      expect(result.value).toMatchObject({ status: 200, createdCount: 0, replacedCount: 1 });
      const after = (await nodeAt(namespaceId, rootId, '/site/index.html'))!;
      expect(after).toMatchObject({ id: before.id, version: before.version + 1 });
      expect(String(after.size)).toBe('4');
      expect(after.blobId).not.toBe(before.blobId);
      const { dataSource } = getContext();
      expect(
        (await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: before.blobId! })).referenceCount,
      ).toBe(0);
      expect(
        (await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: after.blobId! })).referenceCount,
      ).toBe(1);
      expect(await nodeAt(namespaceId, rootId, '/site/keep.txt')).not.toBeNull();
      expect((await nodeAt(namespaceId, rootId, '/site'))!.version).toBe(beforeDestination.version + 1);
      await expectConsistent(namespaceId);
    });

    it('overwrite를 같은 입력으로 다시 실행해도 FILE id가 유지되고 카운터가 어긋나지 않는다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      const entries = () => [
        fileEntry(0, 'a.txt', 'aaa'),
        dirEntry(1, 'empty'),
        fileEntry(2, 'd/b.txt', 'bb'),
      ];
      const first = await run(namespaceId, rootId, plan({ entries: entries() }));
      expect(first.value).toMatchObject({ status: 201, createdCount: 2, replacedCount: 0 });
      const ids = [
        (await nodeAt(namespaceId, rootId, '/site/a.txt'))!.id,
        (await nodeAt(namespaceId, rootId, '/site/d/b.txt'))!.id,
      ];
      const second = await run(namespaceId, rootId, plan({ entries: entries() }));
      expect(second.value).toMatchObject({ status: 200, createdCount: 0, replacedCount: 2 });
      expect([
        (await nodeAt(namespaceId, rootId, '/site/a.txt'))!.id,
        (await nodeAt(namespaceId, rootId, '/site/d/b.txt'))!.id,
      ]).toEqual(ids);
      await expectConsistent(namespaceId);
    });

    it('빈 entries는 overwrite가 기존 대상을 그대로 두고 새 대상은 빈 DIRECTORY로 만든다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/keep.txt', 'keep');
      const existing = await run(namespaceId, rootId, plan({ entries: [] }));
      expect(existing.value).toMatchObject({ status: 200, createdCount: 0, replacedCount: 0 });
      expect(await nodeAt(namespaceId, rootId, '/site/keep.txt')).not.toBeNull();
      const created = await run(namespaceId, rootId, plan({ destinationSegments: ['fresh'], entries: [] }));
      expect(created.value.status).toBe(201);
      expect(await nodeAt(namespaceId, rootId, '/fresh')).toMatchObject({ type: 'DIRECTORY' });
      await expectConsistent(namespaceId);
    });
  });

  describe('clean', () => {
    it('휴지통 OFF면 기존 subtree와 그 안의 source를 지우고 200이며 trashId가 없다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/old.txt', 'old');
      await seedFile(namespaceId, rootId, '/site/sub/old2.txt', 'old2');
      await seedFile(namespaceId, rootId, '/site/up.zip', 'source');
      const before = (await nodeAt(namespaceId, rootId, '/site'))!;
      const result = await run(
        namespaceId,
        rootId,
        plan({ mode: 'clean', entries: [fileEntry(0, 'index.html', 'new')] }),
      );
      expect(result.value).toMatchObject({ status: 200, createdCount: 1, replacedCount: 0 });
      expect(result.value).not.toHaveProperty('trashId');
      for (const gone of ['/site/old.txt', '/site/sub', '/site/sub/old2.txt', '/site/up.zip'])
        expect(await nodeAt(namespaceId, rootId, gone)).toBeNull();
      expect(await sizeAt(namespaceId, rootId, '/site/index.html')).toBe('3');
      expect((await nodeAt(namespaceId, rootId, '/site'))!.id).not.toBe(before.id);
      await expectConsistent(namespaceId);
    });

    it('휴지통 ON이면 200과 trashId를 돌려주고 보관 byte를 센다', async () => {
      const { namespaceId, rootId } = await createNamespace({ trashEnabled: true });
      await seedFile(namespaceId, rootId, '/site/old.txt', 'old');
      const result = await run(
        namespaceId,
        rootId,
        plan({ mode: 'clean', entries: [fileEntry(0, 'index.html', 'x')] }),
      );
      expect(result.value.status).toBe(200);
      expect(typeof result.value.trashId).toBe('string');
      expect(await nodeAt(namespaceId, rootId, '/site/old.txt')).toBeNull();
      const state = await stateOf(namespaceId);
      expect(Number(state.counters.retainedTrashNodeCount)).toBeGreaterThan(0);
      await expectConsistent(namespaceId, { blobReferences: false });
    });

    it('대상이 없으면 clean이어도 삭제 없이 201이다', async () => {
      const { namespaceId, rootId } = await createNamespace({ trashEnabled: true });
      const result = await run(
        namespaceId,
        rootId,
        plan({ mode: 'clean', entries: [fileEntry(0, 'a', 'a')] }),
      );
      expect(result.value.status).toBe(201);
      expect(result.value).not.toHaveProperty('trashId');
      await expectConsistent(namespaceId, { blobReferences: false });
    });

    it('모두 제외돼 entries가 비어도 clean은 기존 대상을 지우고 빈 DIRECTORY를 만든다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/old.txt', 'old');
      const result = await run(namespaceId, rootId, plan({ mode: 'clean', entries: [] }));
      expect(result.value.status).toBe(200);
      expect(await nodeAt(namespaceId, rootId, '/site')).toMatchObject({ type: 'DIRECTORY' });
      expect(await nodeAt(namespaceId, rootId, '/site/old.txt')).toBeNull();
      await expectConsistent(namespaceId);
    });
  });

  describe('종류 충돌과 롤백', () => {
    it('FILE entry의 조상이 기존 FILE이면 409이고 앞 entry 반영도 롤백된다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/assets', 'not a dir');
      const before = await stateOf(namespaceId);
      await expect(
        run(
          namespaceId,
          rootId,
          plan({ entries: [fileEntry(0, 'first.txt', 'a'), fileEntry(1, 'assets/app.js', 'js')] }),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'VFS_EXTRACT_TYPE_CONFLICT',
        entryIndex: 1,
        entryName: 'assets/app.js',
        path: '/site/assets',
      });
      expect(await nodeAt(namespaceId, rootId, '/site/first.txt')).toBeNull();
      expect(await stateOf(namespaceId)).toEqual(before);
      await expectConsistent(namespaceId);
    });

    it('FILE entry가 기존 DIRECTORY와, DIRECTORY entry가 기존 FILE과 겹쳐도 409다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/page/inner.txt', 'in');
      await seedFile(namespaceId, rootId, '/site/data', 'file');
      await expect(
        run(namespaceId, rootId, plan({ entries: [fileEntry(0, 'page', 'p')] })),
      ).rejects.toMatchObject({
        code: 'VFS_EXTRACT_TYPE_CONFLICT',
        entryIndex: 0,
        entryName: 'page',
        path: '/site/page',
      });
      await expect(run(namespaceId, rootId, plan({ entries: [dirEntry(0, 'data')] }))).rejects.toMatchObject({
        code: 'VFS_EXTRACT_TYPE_CONFLICT',
        entryIndex: 0,
        entryName: 'data',
        path: '/site/data',
      });
    });

    it('암시적 조상 자리에 기존 FILE이 있으면 그 FILE 경로를 담은 409다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/a', 'file');
      await expect(
        run(namespaceId, rootId, plan({ entries: [fileEntry(0, 'a/b/c.txt', 'c')] })),
      ).rejects.toMatchObject({
        code: 'VFS_EXTRACT_TYPE_CONFLICT',
        path: '/site/a',
      });
    });

    it('새 destination을 만들던 중 실패하면 destination도 남지 않는다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/other', 'x');
      const before = await stateOf(namespaceId);
      await expect(
        run(
          namespaceId,
          rootId,
          plan({
            destinationSegments: ['fresh'],
            entries: [fileEntry(0, 'a/b.txt', 'b'), fileEntry(1, 'a/b.txt/c', 'c')],
          }),
        ),
      ).rejects.toMatchObject({ code: 'VFS_EXTRACT_TYPE_CONFLICT', entryIndex: 1 });
      expect(await nodeAt(namespaceId, rootId, '/fresh')).toBeNull();
      expect(await stateOf(namespaceId)).toEqual(before);
    });
  });

  describe('기존 한도 오류', () => {
    it('폴더 FILE 수 한도를 넘으면 413이고 전부 롤백된다', async () => {
      const { namespaceId, rootId } = await createNamespace({ maxFilesPerFolder: '2' });
      const before = await stateOf(namespaceId);
      await expect(
        run(
          namespaceId,
          rootId,
          plan({ entries: [fileEntry(0, 'a', 'a'), fileEntry(1, 'b', 'b'), fileEntry(2, 'c', 'c')] }),
        ),
      ).rejects.toMatchObject({ status: 413, code: 'VFS_FOLDER_FILE_LIMIT_EXCEEDED' });
      expect(await stateOf(namespaceId)).toEqual(before);
    });

    it('namespace node 한도를 넘으면 413이고 전부 롤백된다', async () => {
      const { namespaceId, rootId } = await createNamespace({ maxLiveNodes: '3' });
      const before = await stateOf(namespaceId);
      await expect(
        run(namespaceId, rootId, plan({ entries: [fileEntry(0, 'a/b/c.txt', 'c')] })),
      ).rejects.toMatchObject({ status: 413, code: 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED' });
      expect(await stateOf(namespaceId)).toEqual(before);
    });

    it('논리 quota를 넘으면 413이고 전부 롤백된다', async () => {
      const { namespaceId, rootId } = await createNamespace({ maxTotalLogicalBytes: '5' });
      const before = await stateOf(namespaceId);
      await expect(
        run(namespaceId, rootId, plan({ entries: [fileEntry(0, 'a', 'abc'), fileEntry(1, 'b', 'def')] })),
      ).rejects.toMatchObject({ status: 413, code: 'VFS_QUOTA_EXCEEDED' });
      expect(await stateOf(namespaceId)).toEqual(before);
    });

    it('clean 삭제가 동기 삭제 한도를 넘으면 413이고 대상은 그대로다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/a.txt', 'a');
      await seedFile(namespaceId, rootId, '/site/b.txt', 'b');
      const before = await stateOf(namespaceId);
      await expect(
        run(
          namespaceId,
          rootId,
          plan({ mode: 'clean', maxSyncDeleteNodes: 1, entries: [fileEntry(0, 'n', 'n')] }),
        ),
      ).rejects.toMatchObject({ status: 413, code: 'VFS_DELETE_LIMIT_EXCEEDED' });
      expect(await stateOf(namespaceId)).toEqual(before);
    });

    it('휴지통 보관 한도를 넘으면 413이고 대상은 그대로다', async () => {
      // 보관 byte 한도는 휴지통을 quota에서 제외한 namespace에만 적용된다.
      const { namespaceId, rootId } = await createNamespace({
        trashEnabled: true,
        excludeTrashFromQuota: true,
        maxRetainedTrashBytes: '1',
      });
      await seedFile(namespaceId, rootId, '/site/big.txt', 'abcdef');
      const before = await stateOf(namespaceId);
      await expect(
        run(namespaceId, rootId, plan({ mode: 'clean', entries: [fileEntry(0, 'n', 'n')] })),
      ).rejects.toMatchObject({ status: 413, code: 'VFS_TRASH_LIMIT_EXCEEDED' });
      expect(await stateOf(namespaceId)).toEqual(before);
    });

    it('휴지통 ON clean은 보관 byte가 남아 quota를 풀어 주지 않지만 OFF clean은 풀어 준다', async () => {
      const trash = await createNamespace({ trashEnabled: true, maxTotalLogicalBytes: '10' });
      await seedFile(trash.namespaceId, trash.rootId, '/site/old.txt', 'eight888');
      const before = await stateOf(trash.namespaceId);
      await expect(
        run(
          trash.namespaceId,
          trash.rootId,
          plan({ mode: 'clean', entries: [fileEntry(0, 'new.txt', 'five5')] }),
        ),
      ).rejects.toMatchObject({ status: 413, code: 'VFS_QUOTA_EXCEEDED' });
      expect(await stateOf(trash.namespaceId)).toEqual(before);
      const plain = await createNamespace({ maxTotalLogicalBytes: '10' });
      await seedFile(plain.namespaceId, plain.rootId, '/site/old.txt', 'eight888');
      const result = await run(
        plain.namespaceId,
        plain.rootId,
        plan({ mode: 'clean', entries: [fileEntry(0, 'new.txt', 'five5')] }),
      );
      expect(result.value.status).toBe(200);
    });

    it('휴지통 ON clean은 보관 byte가 남아 quota를 풀어 주지 않지만 OFF clean은 풀어 준다', async () => {
      const trash = await createNamespace({ trashEnabled: true, maxTotalLogicalBytes: '10' });
      await seedFile(trash.namespaceId, trash.rootId, '/site/old.txt', 'eight888');
      const before = await stateOf(trash.namespaceId);
      await expect(
        run(
          trash.namespaceId,
          trash.rootId,
          plan({ mode: 'clean', entries: [fileEntry(0, 'new.txt', 'five5')] }),
        ),
      ).rejects.toMatchObject({ status: 413, code: 'VFS_QUOTA_EXCEEDED' });
      expect(await stateOf(trash.namespaceId)).toEqual(before);
      const plain = await createNamespace({ maxTotalLogicalBytes: '10' });
      await seedFile(plain.namespaceId, plain.rootId, '/site/old.txt', 'eight888');
      const result = await run(
        plain.namespaceId,
        plain.rootId,
        plan({ mode: 'clean', entries: [fileEntry(0, 'new.txt', 'five5')] }),
      );
      expect(result.value.status).toBe(200);
    });

    it('교체할 FILE의 version이 상한이면 409 VFS_REVISION_EXHAUSTED다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/a.txt', 'a');
      const node = (await nodeAt(namespaceId, rootId, '/site/a.txt'))!;
      await getContext()
        .dataSource.getRepository(VfsNodeEntity)
        .update({ id: node.id }, { version: MAX_VFS_VERSION });
      await expect(
        run(namespaceId, rootId, plan({ entries: [fileEntry(0, 'a.txt', 'b')] })),
      ).rejects.toMatchObject({
        status: 409,
        code: 'VFS_REVISION_EXHAUSTED',
      });
    });
  });

  describe('커밋 시점 destination 재검사', () => {
    it('destination이 FILE이거나 조상이 FILE이면 409 VFS_NOT_DIRECTORY다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/f', 'x');
      await expect(
        run(namespaceId, rootId, plan({ destinationSegments: ['f'], entries: [] })),
      ).rejects.toMatchObject({
        status: 409,
        code: 'VFS_NOT_DIRECTORY',
        path: '/f',
      });
      await expect(
        run(namespaceId, rootId, plan({ destinationSegments: ['f', 'x'], entries: [] })),
      ).rejects.toMatchObject({ status: 409, code: 'VFS_NOT_DIRECTORY', path: '/f' });
    });

    it('부모가 없으면 첫 부재 조상의 404다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await expect(
        run(namespaceId, rootId, plan({ destinationSegments: ['no', 'such', 'dir'], entries: [] })),
      ).rejects.toMatchObject({ status: 404, code: 'VFS_NODE_NOT_FOUND', path: '/no' });
    });

    it('destinationRevision은 대상이 없으면 404, 다르면 412 current, 같으면 적용한다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedDir(namespaceId, rootId, '/d');
      const directory = (await nodeAt(namespaceId, rootId, '/d'))!;
      await expect(
        run(
          namespaceId,
          rootId,
          plan({
            destinationSegments: ['d'],
            destinationRevision: encodeRevision({ id: directory.id, version: directory.version + 1 }),
            entries: [],
          }),
        ),
      ).rejects.toMatchObject({
        status: 412,
        code: 'VFS_PRECONDITION_FAILED',
        path: '/d',
        current: { id: directory.id, path: '/d', revision: encodeRevision(directory) },
      });
      await expect(
        run(
          namespaceId,
          rootId,
          plan({
            destinationSegments: ['missing'],
            destinationRevision: encodeRevision(directory),
            entries: [],
          }),
        ),
      ).rejects.toMatchObject({ status: 404, code: 'VFS_NODE_NOT_FOUND', path: '/missing' });
      const ok = await run(
        namespaceId,
        rootId,
        plan({
          destinationSegments: ['d'],
          destinationRevision: encodeRevision(directory),
          entries: [fileEntry(0, 'f', 'f')],
        }),
      );
      expect(ok.value.status).toBe(200);
    });

    it('revision을 생략하면 현재 대상에 mode를 적용한다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/a.txt', 'a');
      await seedFile(namespaceId, rootId, '/site/b.txt', 'b');
      await run(namespaceId, rootId, plan({ mode: 'clean', entries: [fileEntry(0, 'c.txt', 'c')] }));
      expect(await nodeAt(namespaceId, rootId, '/site/a.txt')).toBeNull();
      expect(await nodeAt(namespaceId, rootId, '/site/c.txt')).not.toBeNull();
    });
  });

  describe('원자성과 응답 상태', () => {
    it('receipt 완료 같은 afterBump 오류도 모든 반영을 롤백한다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/other/o.txt', 'o');
      const before = await stateOf(namespaceId);
      await expect(
        getContext().repository.withMutation(
          namespaceId,
          rootId,
          (tx) =>
            getContext().repository.applyExtract(
              tx,
              plan({ entries: [fileEntry(0, 'a/b.txt', 'b'), dirEntry(1, 'empty')] }),
            ),
          async () => {
            throw new Error('receipt complete failed');
          },
        ),
      ).rejects.toThrow('receipt complete failed');
      expect(await nodeAt(namespaceId, rootId, '/site')).toBeNull();
      expect(await stateOf(namespaceId)).toEqual(before);
    });

    it('afterBump에서 읽은 resource와 affectedRevisions가 커밋된 상태와 일치한다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      await seedFile(namespaceId, rootId, '/site/old.txt', 'old');
      const repository = getContext().repository;
      const commit = plan({
        mode: 'clean',
        entries: [fileEntry(0, 'index.html', 'new'), fileEntry(1, 'img/a.png', 'png')],
      });
      let resource: Awaited<ReturnType<VfsNodeRepository['readExtractResource']>> | undefined;
      const result = await repository.withMutation(
        namespaceId,
        rootId,
        (tx) => repository.applyExtract(tx, commit),
        async (tx, applied) => {
          resource = await repository.readExtractResource(
            tx,
            applied.value.destinationId,
            commit.destinationSegments,
          );
        },
      );
      const destination = (await nodeAt(namespaceId, rootId, '/site'))!;
      expect(resource).toMatchObject({
        id: destination.id,
        path: '/site',
        type: 'DIRECTORY',
        version: destination.version,
      });
      expect(result.affectedRevisions.find((item) => item.path === '/site')?.revision).toBe(
        encodeRevision(destination),
      );
      // 삭제된 node의 경로는 남지 않고, 남은 경로는 모두 현재 revision과 같다.
      for (const { path, revision } of result.affectedRevisions) {
        // resolvePath는 빈 segment(root)에서 null을 돌려주므로 root는 getRoot로 읽는다.
        const current =
          path === '/' ? await repository.getRoot(namespaceId) : await nodeAt(namespaceId, rootId, path);
        expect(current).not.toBeNull();
        expect(encodeRevision(current!)).toBe(revision);
      }
      expect(result.affectedRevisions.map((item) => item.path)).not.toContain('/site/old.txt');
    });

    it('변경 feed에 clean은 삭제·생성, overwrite는 교체 FILE의 갱신으로 남는다', async () => {
      const { namespaceId, rootId } = await createNamespace();
      const repository = getContext().repository;
      await seedFile(namespaceId, rootId, '/site/old.txt', 'old');
      await seedFile(namespaceId, rootId, '/site/keep.txt', 'keep');
      await repository.createChangeFeedCheckpoint(namespaceId, rootId);
      await run(
        namespaceId,
        rootId,
        plan({ entries: [fileEntry(0, 'keep.txt', 'kept!'), fileEntry(1, 'new.txt', 'n')] }),
      );
      const overwrite = (await repository.listChangeFeedEvents(namespaceId, '0', 1001)).map(
        ({ kind, path }) => `${kind}:${path}`,
      );
      expect(overwrite).toEqual(
        expect.arrayContaining(['updated:/site/keep.txt', 'created:/site/new.txt', 'updated:/site']),
      );
      expect(overwrite).not.toContain('deleted:/site/old.txt');
      const cursor = (await repository.getChangeFeedState(namespaceId))!.lastSequence;
      await run(namespaceId, rootId, plan({ mode: 'clean', entries: [fileEntry(0, 'fresh.txt', 'f')] }));
      const clean = (await repository.listChangeFeedEvents(namespaceId, cursor, 1001)).map(
        ({ kind, path }) => `${kind}:${path}`,
      );
      expect(clean).toEqual(
        expect.arrayContaining([
          'deleted:/site/old.txt',
          'deleted:/site/keep.txt',
          'deleted:/site/new.txt',
          'created:/site/fresh.txt',
        ]),
      );
      expect(clean.filter((item) => item === 'deleted:/site' || item === 'created:/site')).toHaveLength(2);
    });
  });
}
