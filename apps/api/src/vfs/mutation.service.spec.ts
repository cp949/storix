import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository, type MutationTx } from '../persistence/vfs-node.repository.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import type { ArgumentsHost } from '@nestjs/common';
import type { VfsNodeResponseDto } from './dto/node-response.dto.js';
import { errorResponse } from './mutation-receipt.js';
import { MutationService } from './mutation.service.js';
import { VfsNodeNotFoundError, VfsPreconditionFailedError } from './vfs.errors.js';

describe('MutationService 오류 receipt', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const tx = {} as MutationTx;
  const complete = jest.fn<(...args: unknown[]) => Promise<void>>();
  const completeAfterRollback = jest.fn<(...args: unknown[]) => Promise<void>>();
  const release = jest.fn<(...args: unknown[]) => Promise<void>>();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const applyConditionalMutation = jest.fn<VfsNodeRepository['applyConditionalMutation']>();
  let service: MutationService;

  beforeEach(() => {
    jest.clearAllMocks();
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
        claim: async () => ({ kind: 'owner', generation: 4 }),
        complete,
        completeAfterRollback,
        release,
      } as unknown as VfsMutationReceiptRepository,
    );
  });

  const run = (body: string, requestId = 'req-1') =>
    service.executeJson(namespaceId, 'scope', randomUUID(), 'POST', Buffer.from(body), requestId);

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
    const current: VfsNodeResponseDto = {
      path: '/a',
      name: 'a',
      type: 'DIRECTORY',
      size: null,
      mimeType: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 3,
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
});

describe('errorResponse', () => {
  const current: VfsNodeResponseDto = {
    path: '/a',
    name: 'a',
    type: 'FILE',
    size: 3,
    mimeType: 'text/plain',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: 2,
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
