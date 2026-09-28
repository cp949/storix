import { jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { StorageKeyGenerator } from '../../src/storage/storage-key-generator.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { ConditionalContentService } from '../../src/vfs/conditional-content.service.js';
import type {
  VfsConditionalContentResourceDto,
  VfsPreconditionCurrentDto,
} from '../../src/vfs/dto/node-response.dto.js';
import { errorResponse } from '../../src/vfs/mutation-receipt.js';
import { hashParts } from '../../src/vfs/mutation.service.js';
import { PathResolver } from '../../src/vfs/path-resolver.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { VfsInvalidPathError, VfsPreconditionFailedError } from '../../src/vfs/vfs.errors.js';

describe('ConditionalContentService 오류 receipt', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const putConditionalContent = jest.fn<VfsNodeRepository['putConditionalContent']>();
  const claim = jest.fn<VfsMutationReceiptRepository['claim']>();
  const complete = jest.fn<(...args: unknown[]) => Promise<void>>();
  const completeAfterRollback = jest.fn<(...args: unknown[]) => Promise<void>>();
  const release = jest.fn<(...args: unknown[]) => Promise<void>>();
  const put = jest.fn<BlobStorage['put']>();
  const deleteObject = jest.fn<BlobStorage['delete']>();
  const nodes = {
    getRootWithLimits: async () => ({
      root: { id: rootId },
      limits: { maxFileSizeBytes: null, encryptionPolicy: 'PLAINTEXT' },
    }),
    withMutation,
    putConditionalContent,
  } as unknown as VfsNodeRepository;
  const receipts = {
    claim,
    renew: async () => true,
    complete,
    completeAfterRollback,
    release,
  } as unknown as VfsMutationReceiptRepository;
  const service = new ConditionalContentService(
    new PathResolver(),
    nodes,
    receipts,
    { generate: () => 'object-key' } as StorageKeyGenerator,
    { put, delete: deleteObject } as unknown as BlobStorage,
    null,
    { get: () => undefined } as unknown as ConfigService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    claim.mockResolvedValue({ kind: 'owner', generation: 2 });
    complete.mockResolvedValue(undefined);
    completeAfterRollback.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    deleteObject.mockResolvedValue(undefined);
    put.mockImplementation(async (_key, stream) => {
      for await (const chunk of stream) {
        void chunk;
      }
    });
    withMutation.mockImplementation(async (_ns, _root, work, afterBump) => {
      const tx = {} as Parameters<NonNullable<typeof afterBump>>[0];
      const value = await work(tx);
      if (afterBump) await afterBump(tx, { value, affectedRevisions: [] });
      return { value, affectedRevisions: [] };
    });
  });

  function upload(
    path: string,
    ifAbsent: string | undefined,
    ifRevision: string | undefined,
    source: Readable = Readable.from([Buffer.from('body')]),
    requestId = 'req-1',
    expectedSha256?: string,
  ) {
    return service.put(
      namespaceId,
      'scope',
      randomUUID(),
      path,
      ifAbsent,
      ifRevision,
      source,
      'application/octet-stream',
      undefined,
      requestId,
      expectedSha256,
    );
  }

  describe('X-Expires-In', () => {
    it.each([
      ['X-If-Revision과 함께', undefined, 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      ['X-If-Absent 없이', undefined, undefined],
      ['X-If-Absent가 true가 아닐 때', 'false', undefined],
    ])('%s 보내면 receipt claim 전에 400 VFS_INVALID_EXPIRY다', async (_label, ifAbsent, ifRevision) => {
      await expect(
        service.put(
          namespaceId,
          'scope',
          randomUUID(),
          '/a.bin',
          ifAbsent,
          ifRevision,
          Readable.from([]),
          'application/octet-stream',
          '0',
          'req-1',
          undefined,
          '600',
        ),
      ).rejects.toMatchObject({ code: 'VFS_INVALID_EXPIRY', status: 400 });
      expect(claim).not.toHaveBeenCalled();
    });

    it('범위 밖 값은 receipt claim 전에 400 VFS_INVALID_EXPIRY다', async () => {
      const source = Readable.from([Buffer.from('body')]);
      await expect(
        service.put(
          namespaceId,
          'scope',
          randomUUID(),
          '/a.bin',
          'true',
          undefined,
          source,
          'application/octet-stream',
          '0',
          'req-1',
          undefined,
          '59',
        ),
      ).rejects.toMatchObject({ code: 'VFS_INVALID_EXPIRY' });
      expect(source.readableEnded).toBe(false);
      expect(claim).not.toHaveBeenCalled();
    });
  });

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), ' a'.repeat(64)])(
    '잘못된 checksum %j는 body와 receipt를 건드리기 전에 거부한다',
    async (checksum) => {
      const source = Readable.from([Buffer.from('body')]);
      await expect(upload('/x', 'true', undefined, source, 'req-1', checksum)).rejects.toMatchObject({
        code: 'VFS_INVALID_CHECKSUM',
        status: 400,
      });
      expect(source.readableEnded).toBe(false);
      expect(claim).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it('평문 checksum 불일치는 object를 삭제하고 422 receipt를 body와 기대값에 결합한다', async () => {
    const expected = '0'.repeat(64);
    const result = await upload(
      '/x',
      'true',
      undefined,
      Readable.from([Buffer.from('body')]),
      'req-1',
      expected,
    );
    expect(result).toMatchObject({ status: 422, body: { code: 'VFS_CHECKSUM_MISMATCH' } });
    expect(JSON.stringify(result)).not.toContain(expected);
    expect(JSON.stringify(result)).not.toContain(createHash('sha256').update('body').digest('hex'));
    expect(deleteObject).toHaveBeenCalledWith('object-key');
    expect(withMutation).not.toHaveBeenCalled();
    expect(completeAfterRollback.mock.calls[0][2]).toBe(
      hashParts([
        'POST',
        'content/conditional',
        '/x',
        '{"ifAbsent":true}',
        'application/octet-stream',
        createHash('sha256').update('body').digest('hex'),
        expected,
      ]),
    );
    expect(completeAfterRollback.mock.calls[0][5]).toBe(4);
  });

  it('NFD raw path를 업로드 전에 400 응답으로 확정한다', async () => {
    const result = await upload('/é', 'true', undefined);
    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_PATH', requestId: 'req-1' } });
  });

  it('NFD path의 body를 소진하고 400을 오류 receipt로 저장하며 업로드를 남기지 않는다', async () => {
    const source = Readable.from([Buffer.from('body')]);
    const result = await upload('/é', 'true', undefined, source, 'req-2');

    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_PATH' } });
    expect(source.readableEnded).toBe(true);
    expect(completeAfterRollback).toHaveBeenCalledWith(
      expect.objectContaining({ namespaceId }),
      2,
      expect.any(String),
      'POST',
      result,
      4,
    );
    expect(release).not.toHaveBeenCalled();
    expect(withMutation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('업로드 뒤 work의 path 거부는 object 삭제를 시도하고 400을 오류 receipt로 저장한다', async () => {
    deleteObject.mockRejectedValueOnce(new Error('object cleanup failed'));
    putConditionalContent.mockRejectedValueOnce(new VfsInvalidPathError('/rejected'));

    const result = await upload('/valid', 'true', undefined);

    expect(result).toEqual(errorResponse(new VfsInvalidPathError('/rejected'), 'req-1'));
    expect(put).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith('object-key');
    expect(completeAfterRollback).toHaveBeenCalledWith(
      expect.objectContaining({ namespaceId }),
      2,
      expect.any(String),
      'POST',
      result,
      4,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('work의 412는 current를 담은 body로 저장되고 업로드 object는 삭제된다', async () => {
    const current: VfsPreconditionCurrentDto = {
      id: randomUUID(),
      path: '/valid',
      name: 'valid',
      type: 'FILE',
      size: 3,
      mimeType: 'text/plain',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      version: 5,
      expiresAt: null,
      revision: 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    putConditionalContent.mockRejectedValueOnce(new VfsPreconditionFailedError('/valid', current));

    const result = await upload('/valid', 'true', undefined);

    expect(result.status).toBe(412);
    expect(result.body).toMatchObject({ code: 'VFS_PRECONDITION_FAILED', current });
    expect(completeAfterRollback.mock.calls[0][4]).toEqual(result);
    expect(deleteObject).toHaveBeenCalledWith('object-key');
    expect(release).not.toHaveBeenCalled();
  });

  it('업로드 뒤 일반 Error는 object 삭제 후 claim을 해제하고 다시 던진다', async () => {
    putConditionalContent.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(upload('/valid', 'true', undefined)).rejects.toThrow('database unavailable');
    expect(deleteObject).toHaveBeenCalledWith('object-key');
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('오류 receipt fencing 실패는 claim 해제 뒤 claim lost 오류를 전파한다', async () => {
    putConditionalContent.mockRejectedValueOnce(new VfsInvalidPathError('/rejected'));
    completeAfterRollback.mockRejectedValueOnce(new Error('VFS mutation claim lost'));

    await expect(upload('/valid', 'true', undefined)).rejects.toThrow('VFS mutation claim lost');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['X-If-Absent', 'true', undefined, '{"ifAbsent":true}'],
    [
      'X-If-Revision',
      undefined,
      encodeRevision({ id: '00000000-0000-4000-8000-000000000001', version: 3 }),
      JSON.stringify({
        ifRevision: encodeRevision({ id: '00000000-0000-4000-8000-000000000001', version: 3 }),
      }),
    ],
  ])(
    '유효한 %s 요청의 성공 fingerprint는 기존 정규화 조건 형식과 같다',
    async (_title, ifAbsent, ifRevision, conditionJson) => {
      putConditionalContent.mockResolvedValueOnce({
        status: 201,
        resource: { path: '/x', revision: 'r1.test' } as VfsConditionalContentResourceDto,
      });

      const result = await upload('/x', ifAbsent, ifRevision);

      expect(result.status).toBe(201);
      // 이전 버전이 저장한 receipt와 같은 fingerprint여야 같은 key 재시도가 재생된다.
      expect(complete.mock.calls[0][3]).toBe(
        hashParts([
          'POST',
          'content/conditional',
          '/x',
          conditionJson,
          'application/octet-stream',
          createHash('sha256').update('body').digest('hex'),
        ]),
      );
      expect(completeAfterRollback).not.toHaveBeenCalled();
    },
  );

  it('완료 receipt가 있으면 body를 hash만 하고 업로드와 트랜잭션 없이 최초 응답을 재생한다', async () => {
    const receipt = new VfsMutationReceiptEntity();
    receipt.method = 'POST';
    receipt.fingerprint = hashParts([
      'POST',
      'content/conditional',
      '/x',
      '{"ifAbsent":true}',
      'application/octet-stream',
      createHash('sha256').update('body').digest('hex'),
    ]);
    receipt.requestBodyBytes = '4';
    receipt.responseStatus = 201;
    receipt.responseBody = JSON.stringify({ resource: { path: '/x' }, affectedRevisions: [] });
    receipt.responseHeaders = JSON.stringify({ 'x-request-id': 'req-first' });
    claim.mockResolvedValueOnce({ kind: 'complete', receipt });
    const source = Readable.from([Buffer.from('body')]);

    const result = await upload('/x', 'true', undefined, source, 'req-second');

    expect(result).toEqual({
      status: 201,
      body: { resource: { path: '/x' }, affectedRevisions: [] },
      headers: { 'x-request-id': 'req-first' },
    });
    expect(source.readableEnded).toBe(true);
    expect(put).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(withMutation).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('잘못된 조건 헤더 조합과 정규화 실패 원본 경로는 서로 다른 fingerprint를 만든다', async () => {
    const revision = encodeRevision({ id: randomUUID(), version: 1 });
    const cases: [string, string | undefined, string | undefined, number][] = [
      ['/x', undefined, undefined, 428],
      ['/x', 'false', undefined, 400],
      ['/x', 'yes', undefined, 400],
      ['/x', 'true', revision, 400],
      ['/x', undefined, '', 400],
      ['/x', undefined, 'bad', 400],
      ['/x', undefined, 'r1.bad', 400],
      ['/é', 'true', undefined, 400],
      ['/è', 'true', undefined, 400],
      ['/a/../b', 'true', undefined, 400],
    ];
    for (const [path, ifAbsent, ifRevision, status] of cases) {
      expect((await upload(path, ifAbsent, ifRevision)).status).toBe(status);
    }
    const fingerprints = completeAfterRollback.mock.calls.map((call) => call[2]);
    expect(fingerprints).toHaveLength(cases.length);
    expect(new Set(fingerprints).size).toBe(cases.length);

    await upload('/x', 'false', undefined);
    expect(completeAfterRollback.mock.calls.at(-1)?.[2]).toBe(fingerprints[1]);
  });
});
