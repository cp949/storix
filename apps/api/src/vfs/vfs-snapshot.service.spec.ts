import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { VfsSnapshotService } from './vfs-snapshot.service.js';
import { VfsNodeRepository, type MutationTx } from '../persistence/vfs-node.repository.js';
import { VfsSnapshotRepository } from '../persistence/vfs-snapshot.repository.js';
import { VfsMutationReceiptEntity } from '../persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import type { SnapshotSourceRow } from '../persistence/vfs-node.repository.js';
import { errorResponse } from './mutation-receipt.js';
import { encodeRevision } from './revision.js';
import { VfsPreconditionFailedError } from './vfs.errors.js';

describe('VfsSnapshotService receipts', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const tx = {} as MutationTx;
  const complete = jest.fn<(...args: unknown[]) => Promise<void>>();
  const completeAfterRollback = jest.fn<(...args: unknown[]) => Promise<void>>();
  const release = jest.fn<(...args: unknown[]) => Promise<void>>();
  const claim = jest.fn<VfsMutationReceiptRepository['claim']>();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const restoreBlob = jest.fn<VfsNodeRepository['restoreBlob']>();
  const findForUpdate = jest.fn<VfsSnapshotRepository['findForUpdate']>();
  const getFileEntry = jest.fn<VfsSnapshotRepository['getFileEntry']>();
  const remove = jest.fn<VfsSnapshotRepository['remove']>();
  const nodes = {
    getRoot: async () => ({ id: rootId }),
    withMutation,
    restoreBlob,
  } as unknown as VfsNodeRepository;
  const receipts = {
    claim,
    complete,
    completeAfterRollback,
    release,
  } as unknown as VfsMutationReceiptRepository;
  const snapshots = { findForUpdate, getFileEntry, remove } as unknown as VfsSnapshotRepository;
  const storage = { get: async () => Readable.from([]) } as unknown as BlobStorage;
  let service: VfsSnapshotService;

  beforeEach(() => {
    jest.clearAllMocks();
    claim.mockResolvedValue({ kind: 'owner', generation: 1 });
    complete.mockResolvedValue(undefined);
    completeAfterRollback.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
    withMutation.mockImplementation(async (_ns, _root, work, afterBump) => {
      const value = await work(tx);
      const result = { value, affectedRevisions: [] };
      if (afterBump) await afterBump(tx, result);
      return result;
    });
    service = new VfsSnapshotService(nodes, snapshots, receipts, storage, null);
  });

  it('유효하지 않은 JSON의 400을 root transaction 없이 독립 완료로 저장한다', async () => {
    const result = await service.create(namespaceId, 'scope', randomUUID(), Buffer.from('{broken'), 'req-1');
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'VFS_INVALID_MUTATION_REQUEST', requestId: 'req-1' });
    expect(completeAfterRollback).toHaveBeenCalledWith(
      expect.objectContaining({ namespaceId }),
      1,
      expect.any(String),
      'POST',
      result,
      7,
    );
    expect(withMutation).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('restore 조건 누락은 finalize 없이 428 body와 receipt를 그대로 유지한다', async () => {
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
    expect(completeAfterRollback.mock.calls[0][4]).toEqual(result);
  });

  it.each(['restore', 'delete'] as const)(
    '%s의 snapshot ID 형식 오류 404를 receipt로 저장하고 같은 요청에서 재생한다',
    async (operation) => {
      const key = randomUUID();
      const snapshotId = 'not-a-snapshot-uuid';
      const raw = Buffer.from(operation === 'restore' ? '{"path":"/target","ifAbsent":true}' : '{}');
      const run = (requestId: string, body = raw) =>
        operation === 'restore'
          ? service.restore(namespaceId, snapshotId, 'scope', key, body, requestId)
          : service.delete(namespaceId, snapshotId, 'scope', key, body, requestId);

      const first = await run('req-first');
      expect(first.status).toBe(404);
      expect(first.body).toMatchObject({ code: 'VFS_SNAPSHOT_NOT_FOUND', requestId: 'req-first' });
      expect(completeAfterRollback).toHaveBeenCalledWith(
        expect.objectContaining({ namespaceId }),
        1,
        expect.any(String),
        'POST',
        first,
        raw.length,
      );

      const receipt = new VfsMutationReceiptEntity();
      receipt.method = 'POST';
      receipt.fingerprint = completeAfterRollback.mock.calls[0][2] as string;
      receipt.responseStatus = first.status;
      receipt.responseBody = JSON.stringify(first.body);
      receipt.responseHeaders = JSON.stringify(first.headers);
      claim.mockResolvedValueOnce({ kind: 'complete', receipt });

      expect(await run('req-retry')).toEqual(first);
      expect(withMutation).not.toHaveBeenCalled();
    },
  );

  it('잘못된 snapshot ID에서 다른 body를 같은 key로 보내면 409로 거절한다', async () => {
    const key = randomUUID();
    const first = await service.delete(namespaceId, 'bad-id', 'scope', key, Buffer.from('{}'), 'req');
    const receipt = new VfsMutationReceiptEntity();
    receipt.method = 'POST';
    receipt.fingerprint = completeAfterRollback.mock.calls[0][2] as string;
    receipt.responseStatus = first.status;
    receipt.responseBody = JSON.stringify(first.body);
    receipt.responseHeaders = JSON.stringify(first.headers);
    claim.mockResolvedValueOnce({ kind: 'complete', receipt });

    const reused = await service.delete(
      namespaceId,
      'bad-id',
      'scope',
      key,
      Buffer.from('{"different":true}'),
      'req-reused',
    );
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'MUTATION_KEY_REUSED', requestId: 'req-reused' });
  });

  it('잘못된 snapshot ID는 유효한 receipt identity가 없으면 기존 404로 거절한다', async () => {
    const result = await service.delete(
      namespaceId,
      'bad-id',
      undefined,
      undefined,
      Buffer.from('{}'),
      'req',
    );

    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ code: 'VFS_SNAPSHOT_NOT_FOUND', requestId: 'req' });
    expect(claim).not.toHaveBeenCalled();
    expect(completeAfterRollback).not.toHaveBeenCalled();
  });

  it.each(['create', 'delete'] as const)('%s JSON 오류 receipt는 같은 응답을 재생한다', async (operation) => {
    const key = randomUUID();
    const snapshotId = randomUUID();
    const raw = Buffer.from('{broken');
    const run = (requestId: string) =>
      operation === 'create'
        ? service.create(namespaceId, 'scope', key, raw, requestId)
        : service.delete(namespaceId, snapshotId, 'scope', key, raw, requestId);
    const result = await run('req-first');
    const receipt = new VfsMutationReceiptEntity();
    receipt.method = 'POST';
    receipt.fingerprint = completeAfterRollback.mock.calls[0][2] as string;
    receipt.responseStatus = result.status;
    receipt.responseBody = JSON.stringify(result.body);
    receipt.responseHeaders = JSON.stringify(result.headers);
    claim.mockResolvedValueOnce({ kind: 'complete', receipt });
    expect(await run('req-second')).toEqual(result);
    expect(withMutation).not.toHaveBeenCalled();
    expect(completeAfterRollback).toHaveBeenCalledTimes(1);
  });

  it('오류 receipt 완료 실패는 claim을 해제하고 오류를 전파한다', async () => {
    completeAfterRollback.mockRejectedValueOnce(new Error('VFS mutation claim lost'));
    await expect(service.create(namespaceId, 'scope', randomUUID(), undefined, 'req')).rejects.toThrow(
      'VFS mutation claim lost',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('서로 다른 mutation route의 잘못된 본문도 fingerprint가 다르다', async () => {
    await service.create(namespaceId, 'scope', randomUUID(), Buffer.from('{broken'), 'req');
    const createFingerprint = completeAfterRollback.mock.calls[0][2];
    await service.delete(namespaceId, randomUUID(), 'scope', randomUUID(), Buffer.from('{broken'), 'req');
    const deleteFingerprint = completeAfterRollback.mock.calls[1][2];
    expect(deleteFingerprint).not.toBe(createFingerprint);
    await service.restore(namespaceId, randomUUID(), 'scope', randomUUID(), Buffer.from('{broken'), 'req');
    expect(completeAfterRollback.mock.calls[2][2]).not.toBe(createFingerprint);
    expect(completeAfterRollback.mock.calls[2][2]).not.toBe(deleteFingerprint);
  });

  it('work의 restore 412를 롤백 뒤 current body로 저장하고 finalize와 성공 완료를 건너뛴다', async () => {
    const snapshotId = randomUUID();
    findForUpdate.mockResolvedValueOnce({ kind: 'FILE' } as Awaited<
      ReturnType<VfsSnapshotRepository['findForUpdate']>
    >);
    getFileEntry.mockResolvedValueOnce({ blobId: randomUUID(), size: '3', mimeType: 'text/plain' } as Awaited<
      ReturnType<VfsSnapshotRepository['getFileEntry']>
    >);
    restoreBlob.mockRejectedValueOnce(new VfsPreconditionFailedError('/source', null));
    const raw = Buffer.from('{"path":"/source","ifAbsent":true}');

    const result = await service.restore(namespaceId, snapshotId, 'scope', randomUUID(), raw, 'req-412');

    expect(result).toEqual(errorResponse(new VfsPreconditionFailedError('/source', null), 'req-412'));
    expect(completeAfterRollback).toHaveBeenCalledWith(
      expect.objectContaining({ namespaceId }),
      1,
      expect.any(String),
      'POST',
      result,
      raw.length,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('work의 404를 저장하고 일반 Error는 claim을 해제한다', async () => {
    findForUpdate.mockResolvedValueOnce(null);
    const missing = await service.delete(
      namespaceId,
      randomUUID(),
      'scope',
      randomUUID(),
      Buffer.from('{}'),
      'r',
    );
    expect(missing.status).toBe(404);
    expect(completeAfterRollback).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    findForUpdate.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      service.delete(namespaceId, randomUUID(), 'scope', randomUUID(), Buffer.from('{}'), 'r'),
    ).rejects.toThrow('database unavailable');
    expect(completeAfterRollback).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('성공 receipt 완료 실패(claim lost)는 오류 receipt로 저장하지 않는다', async () => {
    findForUpdate.mockResolvedValueOnce({} as Awaited<ReturnType<VfsSnapshotRepository['findForUpdate']>>);
    complete.mockRejectedValueOnce(new Error('VFS mutation claim lost'));

    await expect(
      service.delete(namespaceId, randomUUID(), 'scope', randomUUID(), Buffer.from('{}'), 'r'),
    ).rejects.toThrow('VFS mutation claim lost');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'restore의 snapshot 부재 404',
      () =>
        service.restore(
          namespaceId,
          randomUUID(),
          'scope',
          randomUUID(),
          Buffer.from('{"path":"/target","ifAbsent":true}'),
          'r',
        ),
    ],
    [
      'delete의 snapshot 부재 404',
      () => service.delete(namespaceId, randomUUID(), 'scope', randomUUID(), Buffer.from('{}'), 'r'),
    ],
  ])(
    'work의 %s를 롤백 뒤 저장하다 fencing이 실패하면 claim을 한 번 해제하고 오류를 전파한다',
    async (_title, run) => {
      // work 안의 4xx는 트랜잭션 롤백 뒤 별도 트랜잭션(completeAfterRollback)에서 저장한다.
      findForUpdate.mockResolvedValueOnce(null);
      completeAfterRollback.mockRejectedValueOnce(new Error('VFS mutation claim lost'));

      await expect(run()).rejects.toThrow('VFS mutation claim lost');
      expect(withMutation).toHaveBeenCalledTimes(1);
      expect(completeAfterRollback).toHaveBeenCalledTimes(1);
      expect((completeAfterRollback.mock.calls[0][4] as { status: number }).status).toBe(404);
      expect(complete).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );
});

describe('VfsSnapshotService file snapshot list', () => {
  it('maps repository rows and returns an owner-bound next cursor', async () => {
    const namespaceId = randomUUID();
    const rootNodeId = randomUUID();
    const snapshotId = randomUUID();
    const listFileSnapshots = jest.fn<VfsSnapshotRepository['listFileSnapshots']>().mockResolvedValue({
      items: [
        {
          snapshotId,
          createdAt: new Date('2026-09-26T01:02:03.123Z'),
          createdAtKey: '2026-09-26T01:02:03.123456Z',
          sourceRevision: 'rev',
          logicalBytes: '7',
          sha256: 'a'.repeat(64),
        },
      ],
      nextBoundary: { createdAtKey: '2026-09-26T01:02:03.123456Z', snapshotId },
    });
    const snapshots = { listFileSnapshots } as unknown as VfsSnapshotRepository;
    const nodes = { getRoot: async () => ({ id: randomUUID() }) } as unknown as VfsNodeRepository;
    const service = new VfsSnapshotService(
      nodes,
      snapshots,
      {} as VfsMutationReceiptRepository,
      {} as BlobStorage,
      null,
    );
    const page = await service.listFileSnapshots(namespaceId, rootNodeId, undefined, undefined);
    expect(page.items).toEqual([
      {
        snapshotId,
        createdAt: '2026-09-26T01:02:03.123Z',
        sourceRevision: 'rev',
        logicalBytes: '7',
        sha256: 'a'.repeat(64),
      },
    ]);
    expect(page.nextCursor).toMatch(/^sl1\./);
    expect(listFileSnapshots).toHaveBeenCalledWith(namespaceId, rootNodeId, null, 100);
    await expect(service.listFileSnapshots(namespaceId, 'bad', undefined, undefined)).rejects.toMatchObject({
      code: 'VFS_INVALID_MUTATION_REQUEST',
    });
  });
});

describe('VfsSnapshotService FILE sourceRevision', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const nodeId = randomUUID();
  const currentRevision = encodeRevision({ id: nodeId, version: 3 });
  const staleRevision = encodeRevision({ id: nodeId, version: 2 });
  const otherNodeRevision = encodeRevision({ id: randomUUID(), version: 3 });
  const sourceRow = (type: 'FILE' | 'DIRECTORY'): SnapshotSourceRow => ({
    id: nodeId,
    parentId: rootId,
    name: 'a.txt',
    type,
    revision: currentRevision,
    relativePath: '.',
    blobId: type === 'FILE' ? randomUUID() : null,
    size: type === 'FILE' ? '3' : null,
    mimeType: type === 'FILE' ? 'text/plain' : null,
  });
  const sourceNode = Object.assign(new VfsNodeEntity(), {
    id: nodeId,
    namespaceId,
    parentId: rootId,
    type: 'FILE',
    name: 'a.txt',
    blobId: randomUUID(),
    size: '3',
    mimeType: 'text/plain',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    version: 3,
  });
  const captureSnapshotRows = jest.fn<VfsNodeRepository['captureSnapshotRows']>();
  const capture = jest.fn<VfsSnapshotRepository['capture']>();
  const findOneBy = jest.fn(async (entity: unknown) =>
    entity === NamespaceEntity
      ? ({
          id: namespaceId,
          maxSyncSnapshotNodes: null,
          maxSnapshotBytes: null,
          maxRetainedSnapshotNodes: null,
          maxRetainedSnapshotBytes: null,
        } as NamespaceEntity)
      : sourceNode,
  );
  const tx = { manager: { findOneBy } } as unknown as MutationTx;
  const completeAfterRollback = jest.fn<(...args: unknown[]) => Promise<void>>();
  const nodes = {
    getRoot: async () => ({ id: rootId }),
    captureSnapshotRows,
    withMutation: async (
      _ns: string,
      _root: string,
      work: (t: MutationTx) => Promise<unknown>,
      afterBump?: (t: MutationTx, r: unknown) => Promise<void>,
    ) => {
      const value = await work(tx);
      if (afterBump) await afterBump(tx, { value, affectedRevisions: [] });
      return { value, affectedRevisions: [] };
    },
  } as unknown as VfsNodeRepository;
  const receipts = {
    claim: async () => ({ kind: 'owner', generation: 1 }),
    complete: async () => undefined,
    completeAfterRollback,
    release: async () => undefined,
  } as unknown as VfsMutationReceiptRepository;
  const service = new VfsSnapshotService(
    nodes,
    { capture } as unknown as VfsSnapshotRepository,
    receipts,
    {} as BlobStorage,
    null,
  );
  const create = (body: Record<string, unknown>) =>
    service.create(namespaceId, 'scope', randomUUID(), Buffer.from(JSON.stringify(body)), 'req');

  beforeEach(() => {
    jest.clearAllMocks();
    completeAfterRollback.mockResolvedValue(undefined);
    captureSnapshotRows.mockResolvedValue([sourceRow('FILE')]);
    capture.mockResolvedValue({
      id: randomUUID(),
      kind: 'FILE',
      sourcePath: '/a.txt',
      sourceRevision: currentRevision,
      rootNodeId: nodeId,
      sha256: 'a'.repeat(64),
      rootType: 'FILE',
      nodeCount: 1,
      logicalBytes: 3n,
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
    } as unknown as Awaited<ReturnType<VfsSnapshotRepository['capture']>>);
  });

  it('sourceRevision이 원본 현재 revision과 일치하면 capture를 호출하고 201을 반환한다', async () => {
    const result = await create({ kind: 'file', path: '/a.txt', sourceRevision: currentRevision });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ rootNodeId: nodeId, sha256: 'a'.repeat(64) });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('sourceRevision이 없으면 비교 없이 capture를 호출한다', async () => {
    const result = await create({ kind: 'file', path: '/a.txt' });
    expect(result.status).toBe(201);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['version이 다른 revision', staleRevision],
    ['다른 노드의 revision', otherNodeRevision],
  ])('sourceRevision이 %s이면 capture 없이 current를 담은 412를 반환한다', async (_name, sourceRevision) => {
    const result = await create({ kind: 'file', path: '/a.txt', sourceRevision });
    expect(capture).not.toHaveBeenCalled();
    // current는 capture 행의 노드 ID로 같은 namespace 안에서 다시 읽은 원본이다.
    expect(findOneBy).toHaveBeenCalledWith(VfsNodeEntity, { id: sourceRow('FILE').id, namespaceId });
    expect(result).toEqual(
      errorResponse(
        new VfsPreconditionFailedError('/a.txt', {
          id: sourceRow('FILE').id,
          path: '/a.txt',
          name: 'a.txt',
          type: 'FILE',
          size: 3,
          mimeType: 'text/plain',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          version: 3,
          revision: currentRevision,
        }),
        'req',
      ),
    );
    expect(result.status).toBe(412);
    expect(completeAfterRollback).toHaveBeenCalledTimes(1);
  });

  it('원본이 디렉터리면 revision 불일치보다 409가 먼저이고 capture를 호출하지 않는다', async () => {
    captureSnapshotRows.mockResolvedValue([sourceRow('DIRECTORY')]);
    const result = await create({ kind: 'file', path: '/a.txt', sourceRevision: staleRevision });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'VFS_IS_DIRECTORY' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('원본이 없으면 revision 불일치보다 404가 먼저이고 capture를 호출하지 않는다', async () => {
    const { VfsNodeNotFoundError } = await import('./vfs.errors.js');
    captureSnapshotRows.mockRejectedValue(new VfsNodeNotFoundError('/a.txt'));
    const result = await create({ kind: 'file', path: '/a.txt', sourceRevision: staleRevision });
    expect(result.status).toBe(404);
    expect(capture).not.toHaveBeenCalled();
  });

  it('TREE에 sourceRevision을 주면 트랜잭션 없이 400을 저장한다', async () => {
    const result = await create({ kind: 'tree', path: '/a', sourceRevision: currentRevision });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'VFS_INVALID_MUTATION_REQUEST' });
    expect(captureSnapshotRows).not.toHaveBeenCalled();
  });

  it('형식이 잘못된 sourceRevision은 400 VFS_INVALID_REVISION을 저장한다', async () => {
    const result = await create({ kind: 'file', path: '/a.txt', sourceRevision: 'r1.bad' });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'VFS_INVALID_REVISION' });
    expect(captureSnapshotRows).not.toHaveBeenCalled();
  });

  it('조건 없는 요청과 있는 요청은 fingerprint가 다르고 조건 없는 fingerprint는 기존 command JSON으로 만든다', async () => {
    const { hashParts } = await import('./mutation.service.js');
    const { createHash } = await import('node:crypto');
    const fingerprints: string[] = [];
    const spy = new VfsSnapshotService(
      nodes,
      { capture } as unknown as VfsSnapshotRepository,
      {
        ...receipts,
        complete: async (...args: unknown[]) => {
          fingerprints.push(args[3] as string);
        },
      } as unknown as VfsMutationReceiptRepository,
      {} as BlobStorage,
      null,
    );
    const plain = Buffer.from('{"kind":"file","path":"/a.txt"}');
    await spy.create(namespaceId, 'scope', randomUUID(), plain, 'req');
    await spy.create(
      namespaceId,
      'scope',
      randomUUID(),
      Buffer.from(JSON.stringify({ kind: 'file', path: '/a.txt', sourceRevision: currentRevision })),
      'req',
    );
    // 이전 버전이 저장한 receipt와 같은 fingerprint여야 재시도가 호환된다.
    expect(fingerprints[0]).toBe(
      hashParts([
        'POST',
        'snapshots',
        '{"kind":"file","path":"/a.txt"}',
        createHash('sha256').update(plain).digest('hex'),
      ]),
    );
    expect(fingerprints[1]).not.toBe(fingerprints[0]);
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
      contentPath: `/api/v2/namespaces/${namespaceId}/fs/snapshots/${snapshotId}/content?path=a%2F%ED%95%9C`,
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
    code: 'VFS_SNAPSHOT_NOT_FOUND',
  });
});
