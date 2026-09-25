import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { VfsSnapshotService } from './vfs-snapshot.service.js';
import { VfsNodeRepository, type MutationTx } from '../persistence/vfs-node.repository.js';
import { VfsSnapshotRepository } from '../persistence/vfs-snapshot.repository.js';
import { VfsMutationReceiptEntity } from '../persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';

describe('VfsSnapshotService receipts', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const tx = {} as MutationTx;
  const complete = jest.fn<(...args: unknown[]) => Promise<void>>();
  const release = jest.fn<(...args: unknown[]) => Promise<void>>();
  const claim = jest.fn<VfsMutationReceiptRepository['claim']>();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const nodes = { getRoot: async () => ({ id: rootId }), withMutation } as unknown as VfsNodeRepository;
  const receipts = { claim, complete, release } as unknown as VfsMutationReceiptRepository;
  const snapshots = {} as VfsSnapshotRepository;
  const storage = { get: async () => Readable.from([]) } as unknown as BlobStorage;
  let service: VfsSnapshotService;

  beforeEach(() => {
    jest.clearAllMocks();
    claim.mockResolvedValue({ kind: 'owner', generation: 1 });
    complete.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    withMutation.mockImplementation(async (_ns, _root, work, afterBump) => {
      const value = await work(tx);
      const result = { value, affectedRevisions: [] };
      if (afterBump) await afterBump(tx, result);
      return result;
    });
    service = new VfsSnapshotService(nodes, snapshots, receipts, storage, null);
  });

  it('유효하지 않은 JSON의 receipt를 root transaction의 after-bump에 저장한다', async () => {
    const result = await service.create(namespaceId, 'scope', randomUUID(), Buffer.from('{broken'), 'req-1');
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'VFS_INVALID_MUTATION_REQUEST', requestId: 'req-1' });
    expect(complete).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ namespaceId }),
      1,
      expect.any(String),
      'POST',
      result,
      7,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('restore 조건 누락은 finalize 뒤에도 428 body와 receipt를 그대로 유지한다', async () => {
    const result = await service.restore(
      namespaceId,
      randomUUID(),
      'scope',
      randomUUID(),
      Buffer.from('{"path":"/target"}'),
      'req',
    );
    expect(result.status).toBe(428);
    expect(result.body).toMatchObject({ code: 'VFS_PRECONDITION_REQUIRED', requestId: 'req' });
    expect(complete.mock.calls[0][5]).toEqual(result);
  });

  it.each(['create', 'delete'] as const)(
    '%s JSON 오류 receipt는 finalize 확장 뒤에도 같은 응답을 재생한다',
    async (operation) => {
      const key = randomUUID();
      const snapshotId = randomUUID();
      const raw = Buffer.from('{broken');
      const run = () =>
        operation === 'create'
          ? service.create(namespaceId, 'scope', key, raw, 'req-first')
          : service.delete(namespaceId, snapshotId, 'scope', key, raw, 'req-first');
      const result = await run();
      const receipt = new VfsMutationReceiptEntity();
      receipt.method = 'POST';
      receipt.fingerprint = complete.mock.calls[0][3] as string;
      receipt.responseStatus = result.status;
      receipt.responseBody = JSON.stringify(result.body);
      receipt.responseHeaders = JSON.stringify(result.headers);
      claim.mockResolvedValueOnce({ kind: 'complete', receipt });
      expect(await run()).toEqual(result);
      expect(withMutation).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it('receipt 완료 실패는 claim을 해제하고 오류를 전파한다', async () => {
    complete.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.create(namespaceId, 'scope', randomUUID(), undefined, 'req')).rejects.toThrow(
      'database unavailable',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('서로 다른 mutation route의 잘못된 본문도 fingerprint가 다르다', async () => {
    await service.create(namespaceId, 'scope', randomUUID(), Buffer.from('{broken'), 'req');
    const createFingerprint = complete.mock.calls[0][3];
    await service.delete(namespaceId, randomUUID(), 'scope', randomUUID(), Buffer.from('{broken'), 'req');
    const deleteFingerprint = complete.mock.calls[1][3];
    expect(deleteFingerprint).not.toBe(createFingerprint);
    await service.restore(namespaceId, randomUUID(), 'scope', randomUUID(), Buffer.from('{broken'), 'req');
    expect(complete.mock.calls[2][3]).not.toBe(createFingerprint);
    expect(complete.mock.calls[2][3]).not.toBe(deleteFingerprint);
  });
});

describe('VfsSnapshotService content stream lifecycle', () => {
  const namespaceId = randomUUID();
  const snapshotId = randomUUID();
  const rootId = randomUUID();
  const blobId = randomUUID();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const nodes = { getRoot: async () => ({ id: rootId }), withMutation } as unknown as VfsNodeRepository;
  const snapshots = {
    findForUpdate: async () => ({ kind: 'FILE', sourcePath: '/a' }),
    getFileEntry: async () => ({ blobId, size: '1', mimeType: 'application/octet-stream' }),
  } as unknown as VfsSnapshotRepository;
  const tx = {
    manager: {
      findOneBy: async () => ({ storageKey: 'blob-key', encryptionPolicy: 'NONE' }),
    },
  } as unknown as MutationTx;

  it('DB commit이 실패하면 이미 열린 Blob stream을 파기한다', async () => {
    const stream = new Readable({ read() {} });
    const storage = { get: async () => stream } as unknown as BlobStorage;
    withMutation.mockImplementationOnce(async (_ns, _root, work) => {
      await work(tx);
      throw new Error('commit failed');
    });
    const service = new VfsSnapshotService(
      nodes,
      snapshots,
      {} as VfsMutationReceiptRepository,
      storage,
      null,
    );
    await expect(service.getContent(namespaceId, snapshotId, undefined, undefined)).rejects.toThrow(
      'commit failed',
    );
    expect(stream.destroyed).toBe(true);
  });

  it('commit 대기 중 Blob stream 오류를 기록하고 성공 payload 대신 오류를 반환한다', async () => {
    const stream = new Readable({ read() {} });
    const storage = { get: async () => stream } as unknown as BlobStorage;
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let commit!: () => void;
    const commitPromise = new Promise<void>((resolve) => {
      commit = resolve;
    });
    withMutation.mockImplementationOnce(async (_ns, _root, work) => {
      const value = await work(tx);
      opened();
      await commitPromise;
      return { value, affectedRevisions: [] };
    });
    const service = new VfsSnapshotService(
      nodes,
      snapshots,
      {} as VfsMutationReceiptRepository,
      storage,
      null,
    );
    const result = service.getContent(namespaceId, snapshotId, undefined, undefined);
    await openedPromise;
    // 회귀 전 코드도 process를 종료시키지 않도록 테스트에서 오류 발생을 관찰한다.
    const emitted = new Promise<void>((resolve) => stream.once('error', () => resolve()));
    stream.destroy(new Error('Blob connection failed during commit'));
    await emitted;
    commit();
    await expect(result).rejects.toThrow('Blob connection failed during commit');
    expect(stream.destroyed).toBe(true);
  });
});

describe('VfsSnapshotService immutable entry pages', () => {
  const namespaceId = randomUUID();
  const snapshotId = randomUUID();
  const sourceNodeId = randomUUID();
  const entry = {
    id: randomUUID(),
    namespaceId,
    snapshotId,
    relativePath: 'a/한',
    pathKey: '612fed959c',
    type: 'FILE' as const,
    sourceNodeId,
    sourceRevision: 'captured-revision',
    blobId: randomUUID(),
    size: '7',
    mimeType: 'application/octet-stream',
  };
  const service = new VfsSnapshotService(
    { getRoot: async () => ({ id: randomUUID() }) } as unknown as VfsNodeRepository,
    {
      get: async () => ({ kind: 'TREE' }),
      listEntries: async (_namespace: string, _snapshot: string, _after: string | null, limit: number) => ({
        entries: Array.from({ length: limit }, () => entry),
        nextPathKey: entry.pathKey,
      }),
    } as unknown as VfsSnapshotRepository,
    {} as VfsMutationReceiptRepository,
    {} as BlobStorage,
    null,
  );

  it.each([
    [undefined, 100],
    ['1001', 1000],
    ['2', 2],
    ['0', 100],
    ['NaN', 100],
  ] as const)('page limit %s는 공개 manifest %s개로 해석한다', async (limit, count) => {
    const page = await service.listEntries(namespaceId, snapshotId, undefined, limit);
    expect(page.items).toHaveLength(count);
    expect(page.items[0]).toEqual({
      relativePath: 'a/한',
      type: 'FILE',
      sourceNodeId,
      sourceRevision: 'captured-revision',
      size: '7',
      mimeType: 'application/octet-stream',
      contentPath: `/api/v1/namespaces/${namespaceId}/fs/snapshots/${snapshotId}/content?path=a%2F%ED%95%9C`,
    });
    expect(JSON.parse(Buffer.from(page.nextCursor!.slice(4), 'base64url').toString('utf8'))).toEqual({
      snapshotId,
      pathKey: '612fed959c',
    });
  });

  it('다른 snapshot의 cursor와 비정규 cursor는 페이지를 읽기 전에 거부한다', async () => {
    const foreign = `sc1.${Buffer.from(JSON.stringify({ snapshotId: randomUUID(), pathKey: '2e' })).toString('base64url')}`;
    for (const cursor of ['', 'bad', foreign])
      await expect(service.listEntries(namespaceId, snapshotId, cursor, undefined)).rejects.toMatchObject({
        code: 'VFS_INVALID_CURSOR',
      });
  });
});

it('metadata 확인 뒤 삭제된 TREE는 빈 성공 페이지 대신 404를 반환한다', async () => {
  let present = true;
  const service = new VfsSnapshotService(
    { getRoot: async () => ({ id: randomUUID() }) } as unknown as VfsNodeRepository,
    {
      get: async () => (present ? { kind: 'TREE' } : null),
      listEntries: async () => {
        present = false;
        return { entries: [], nextPathKey: null };
      },
    } as unknown as VfsSnapshotRepository,
    {} as VfsMutationReceiptRepository,
    {} as BlobStorage,
    null,
  );
  await expect(service.listEntries(randomUUID(), randomUUID(), undefined, undefined)).rejects.toMatchObject({
    code: 'VFS_NODE_NOT_FOUND',
  });
});
