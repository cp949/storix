import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository, type MutationTx } from '../../src/persistence/vfs-node.repository.js';
import { DomainErrorFilter } from '../../src/common/domain-error.filter.js';
import { StorageUnavailableError } from '../../src/common/storage-failure.errors.js';
import type { ArgumentsHost } from '@nestjs/common';
import type { VfsNodeResponseDto, VfsPreconditionCurrentDto } from '../../src/vfs/dto/node-response.dto.js';
import { errorResponse } from '../../src/vfs/mutation-receipt.js';
import { MutationService } from '../../src/vfs/mutation.service.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { VfsNodeNotFoundError, VfsPreconditionFailedError } from '../../src/vfs/vfs.errors.js';
import type { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';

describe('MutationService 오류 receipt', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const tx = {} as MutationTx;
  const claim = jest.fn<VfsMutationReceiptRepository['claim']>();
  const complete = jest.fn<(...args: unknown[]) => Promise<void>>();
  const completeAfterRollback = jest.fn<(...args: unknown[]) => Promise<void>>();
  const release = jest.fn<(...args: unknown[]) => Promise<void>>();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const applyConditionalMutation = jest.fn<VfsNodeRepository['applyConditionalMutation']>();
  let service: MutationService;

  beforeEach(() => {
    jest.clearAllMocks();
    claim.mockResolvedValue({ kind: 'owner', generation: 4 });
    complete.mockResolvedValue(undefined);
    completeAfterRollback.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    withMutation.mockImplementation(async (_ns, _root, work, afterBump) => {
      const value = await work(tx);
      const result = { value, affectedRevisions: [] };
      if (afterBump) await afterBump(tx, result);
      return result;
    });
    service = new MutationService(
      {
        getRoot: async () => ({ id: rootId }),
        withMutation,
        applyConditionalMutation,
      } as unknown as VfsNodeRepository,
      {
        claim,
        complete,
        completeAfterRollback,
        release,
      } as unknown as VfsMutationReceiptRepository,
      { get: () => undefined } as unknown as ConfigService,
    );
  });

  const run = (body: string, requestId = 'req-1') =>
    service.executeJson(namespaceId, 'scope', randomUUID(), 'POST', Buffer.from(body), requestId);

  it('receipt claim의 STORAGE_UNAVAILABLE은 owner 없이 전파하고 작업·완료·해제를 하지 않는다', async () => {
    const error = new StorageUnavailableError('private database endpoint');
    claim.mockRejectedValueOnce(error);

    await expect(run('{"kind":"mkdir","path":"/a","ifAbsent":true}')).rejects.toBe(error);
    expect(withMutation).not.toHaveBeenCalled();
    expect(applyConditionalMutation).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('NFD path의 400을 트랜잭션 없이 오류 receipt로 저장하고 claim을 유지한다', async () => {
    const result = await run('{"kind":"mkdir","path":"/e\\u0301","ifAbsent":true}');

    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_PATH' } });
    expect(withMutation).not.toHaveBeenCalled();
    expect(completeAfterRollback).toHaveBeenCalledWith(
      expect.objectContaining({ namespaceId }),
      4,
      expect.any(String),
      'POST',
      result,
      undefined,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('work의 412를 롤백 뒤 current를 담은 body 그대로 저장한다', async () => {
    const current: VfsPreconditionCurrentDto = {
      id: randomUUID(),
      path: '/a',
      name: 'a',
      type: 'DIRECTORY',
      size: null,
      mimeType: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 3,
      expiresAt: null,
      revision: 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    applyConditionalMutation.mockRejectedValueOnce(new VfsPreconditionFailedError('/a', current));

    const result = await run('{"kind":"mkdir","path":"/a","ifAbsent":true}');

    expect(result).toEqual(errorResponse(new VfsPreconditionFailedError('/a', current), 'req-1'));
    expect(completeAfterRollback).toHaveBeenCalledTimes(1);
    expect(completeAfterRollback.mock.calls[0][4]).toEqual(result);
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('일반 Error는 저장하지 않고 claim을 해제한 뒤 다시 던진다', async () => {
    applyConditionalMutation.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(run('{"kind":"mkdir","path":"/a","ifAbsent":true}')).rejects.toThrow('database unavailable');
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ namespaceId }), 4);
  });

  it('work의 STORAGE_UNAVAILABLE은 rollback receipt 없이 claim을 한 번 해제하고 원형 전파한다', async () => {
    const error = new StorageUnavailableError('private database endpoint');
    applyConditionalMutation.mockRejectedValueOnce(error);

    await expect(run('{"kind":"mkdir","path":"/a","ifAbsent":true}')).rejects.toBe(error);
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ namespaceId }), 4);
  });

  it('오류 receipt fencing 실패는 claim 해제 뒤 claim lost 오류를 전파한다', async () => {
    applyConditionalMutation.mockRejectedValueOnce(new VfsNodeNotFoundError('/a'));
    completeAfterRollback.mockRejectedValueOnce(new Error('VFS mutation claim lost'));

    await expect(run('{"kind":"mkdir","path":"/a/b","ifAbsent":true}')).rejects.toThrow(
      'VFS mutation claim lost',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('성공 receipt 완료 실패(claim lost)는 오류 receipt로 저장하지 않는다', async () => {
    applyConditionalMutation.mockResolvedValueOnce({ status: 201, resource: null });
    complete.mockRejectedValueOnce(new Error('VFS mutation claim lost'));

    await expect(run('{"kind":"mkdir","path":"/a","ifAbsent":true}')).rejects.toThrow(
      'VFS mutation claim lost',
    );
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('성공 receipt 완료의 STORAGE_UNAVAILABLE은 rollback receipt 없이 claim을 한 번 해제한다', async () => {
    const error = new StorageUnavailableError('private database endpoint');
    applyConditionalMutation.mockResolvedValueOnce({ status: 201, resource: null });
    complete.mockRejectedValueOnce(error);

    await expect(run('{"kind":"mkdir","path":"/a","ifAbsent":true}')).rejects.toBe(error);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(completeAfterRollback).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ namespaceId }), 4);
  });

  it('결정적 4xx의 rollback receipt 완료에 STORAGE_UNAVAILABLE이 나면 4xx 대신 저장 오류를 전파한다', async () => {
    const error = new StorageUnavailableError('private database endpoint');
    applyConditionalMutation.mockRejectedValueOnce(new VfsNodeNotFoundError('/a'));
    completeAfterRollback.mockRejectedValueOnce(error);

    await expect(run('{"kind":"mkdir","path":"/a","ifAbsent":true}')).rejects.toBe(error);
    expect(complete).not.toHaveBeenCalled();
    expect(completeAfterRollback).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ namespaceId }), 4);
  });
});

describe('MutationService 만료 범위와 재생', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const tx = {} as MutationTx;
  const claim = jest.fn<VfsMutationReceiptRepository['claim']>();
  const complete = jest.fn<(...args: unknown[]) => Promise<void>>();
  const completeAfterRollback = jest.fn<(...args: unknown[]) => Promise<void>>();
  const release = jest.fn<(...args: unknown[]) => Promise<void>>();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const applyConditionalMutation = jest.fn<VfsNodeRepository['applyConditionalMutation']>();
  const revision = encodeRevision({ id: '00000000-0000-4000-8000-000000000001', version: 3 });

  // 범위는 STORIX_VFS_EXPIRY_*_SECONDS로 바뀔 수 있으므로 env를 달리한 인스턴스로 재시도를 흉내 낸다.
  const serviceWithBounds = (min?: string, max?: string) =>
    new MutationService(
      {
        getRoot: async () => ({ id: rootId }),
        withMutation,
        applyConditionalMutation,
      } as unknown as VfsNodeRepository,
      { claim, complete, completeAfterRollback, release } as unknown as VfsMutationReceiptRepository,
      {
        get: (name: string) =>
          name === 'STORIX_VFS_EXPIRY_MIN_SECONDS'
            ? min
            : name === 'STORIX_VFS_EXPIRY_MAX_SECONDS'
              ? max
              : undefined,
      } as unknown as ConfigService,
    );

  const copyBody = (expiresInSeconds: number) =>
    JSON.stringify({
      kind: 'copy',
      source: '/a',
      destination: '/b',
      sourceRevision: revision,
      destinationAbsent: true,
      expiresInSeconds,
    });

  const run = (svc: MutationService, body: string) =>
    svc.executeJson(namespaceId, 'scope', randomUUID(), 'POST', Buffer.from(body), 'req-1');

  const completeReceipt = (
    fingerprint: string,
    result: { status: number; body: unknown; headers: unknown },
  ) =>
    ({
      method: 'POST',
      fingerprint,
      responseStatus: result.status,
      responseBody: JSON.stringify(result.body),
      responseHeaders: JSON.stringify(result.headers),
    }) as VfsMutationReceiptEntity;

  beforeEach(() => {
    jest.clearAllMocks();
    claim.mockResolvedValue({ kind: 'owner', generation: 4 });
    complete.mockResolvedValue(undefined);
    completeAfterRollback.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    withMutation.mockImplementation(async (_ns, _root, work, afterBump) => {
      const value = await work(tx);
      const result = { value, affectedRevisions: [] };
      if (afterBump) await afterBump(tx, result);
      return result;
    });
  });

  it('완료된 copy는 범위를 좁힌 뒤 같은 키로 재시도해도 저장된 응답을 재생한다', async () => {
    const copied: VfsNodeResponseDto = {
      id: randomUUID(),
      path: '/b',
      name: 'b',
      type: 'FILE',
      size: 1,
      mimeType: 'text/plain',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      expiresAt: null,
    };
    applyConditionalMutation.mockResolvedValue({ status: 201, resource: copied });
    const first = await run(serviceWithBounds(), copyBody(600));
    expect(first.status).toBe(201);
    const fingerprint = complete.mock.calls[0][3] as string;
    claim.mockResolvedValue({ kind: 'complete', receipt: completeReceipt(fingerprint, first) });
    applyConditionalMutation.mockClear();

    const retried = await run(serviceWithBounds('3600'), copyBody(600));

    expect(retried).toEqual(first);
    expect(applyConditionalMutation).not.toHaveBeenCalled();
  });

  it('범위 밖이라 저장된 400은 범위를 넓힌 뒤 같은 키로 재시도해도 재생한다', async () => {
    const first = await run(serviceWithBounds(), copyBody(59));
    expect(first).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_EXPIRY' } });
    const fingerprint = completeAfterRollback.mock.calls[0][2] as string;
    claim.mockResolvedValue({ kind: 'complete', receipt: completeReceipt(fingerprint, first) });

    expect(await run(serviceWithBounds('30'), copyBody(59))).toEqual(first);
    expect(await run(serviceWithBounds('30'), copyBody(61))).toMatchObject({
      status: 409,
      body: { code: 'MUTATION_KEY_REUSED' },
    });
  });

  it('범위 밖 값은 트랜잭션 없이 400 VFS_INVALID_EXPIRY를 오류 receipt로 저장한다', async () => {
    const result = await run(serviceWithBounds(), copyBody(59));

    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_EXPIRY' } });
    expect(withMutation).not.toHaveBeenCalled();
    expect(completeAfterRollback).toHaveBeenCalledTimes(1);
  });
});

describe('errorResponse', () => {
  const current: VfsPreconditionCurrentDto = {
    id: randomUUID(),
    path: '/a',
    name: 'a',
    type: 'FILE',
    size: 3,
    mimeType: 'text/plain',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: 2,
    expiresAt: null,
    revision: 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };

  function filterBody(error: Error): unknown {
    const json = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json }) }),
        getRequest: () => ({ requestId: 'req-1', method: 'POST', path: '/x' }),
      }),
    } as unknown as ArgumentsHost;
    new DomainErrorFilter().catch(error, host);
    return json.mock.calls[0][0];
  }

  it('412 오류의 current를 body에 포함한다', () => {
    const result = errorResponse(new VfsPreconditionFailedError('/a', current), 'req-1');

    expect(result).toEqual({
      status: 412,
      body: {
        code: 'VFS_PRECONDITION_FAILED',
        message: 'mutation 전제조건 불일치: /a',
        path: '/a',
        current,
        requestId: 'req-1',
      },
      headers: { 'x-request-id': 'req-1' },
    });
  });

  it('412 오류의 current가 null이면 null을 유지한다', () => {
    const result = errorResponse(new VfsPreconditionFailedError('/a', null), 'req-1');

    expect(result.body).toMatchObject({ current: null });
  });

  it('current가 없는 오류의 body는 기존 형태를 유지한다', () => {
    const result = errorResponse(new VfsNodeNotFoundError('/a'), 'req-1');

    expect(result.body).toEqual({
      code: 'VFS_NODE_NOT_FOUND',
      message: '존재하지 않는 경로: /a',
      path: '/a',
      requestId: 'req-1',
    });
  });

  it.each([
    ['412 current 있음', new VfsPreconditionFailedError('/a', current)],
    ['412 current null', new VfsPreconditionFailedError('/a', null)],
    ['404', new VfsNodeNotFoundError('/a')],
  ])('%s: DomainErrorFilter body와 errorResponse body가 일치한다', (_title, error) => {
    expect(errorResponse(error, 'req-1').body).toEqual(filterBody(error));
  });
});
