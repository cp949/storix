import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { InvalidApiKeyError } from '../auth/auth.errors.js';
import { DomainError } from '../common/domain-error.js';
import { VfsMutationReceiptEntity } from '../persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import {
  busyResponse,
  isReplayableMutationError,
  replayReceipt,
  storeErrorReceipt,
  type ErrorReceiptOwner,
} from './mutation-receipt.js';
import {
  VfsAlreadyExistsError,
  VfsCopyLimitExceededError,
  VfsDeleteLimitExceededError,
  VfsInvalidMutationRequestError,
  VfsInvalidPathError,
  VfsInvalidRevisionError,
  VfsIsDirectoryError,
  VfsNamespaceNotFoundError,
  VfsNodeNotFoundError,
  VfsPreconditionFailedError,
  VfsPreconditionRequiredError,
  VfsRevisionExhaustedError,
  VfsSnapshotLimitExceededError,
  VfsQuotaExceededError,
} from './vfs.errors.js';

class CodedError extends DomainError {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

describe('isReplayableMutationError', () => {
  it.each([
    ['400 VFS_INVALID_MUTATION_REQUEST', new VfsInvalidMutationRequestError()],
    ['400 VFS_INVALID_PATH', new VfsInvalidPathError('/é')],
    ['400 VFS_INVALID_REVISION', new VfsInvalidRevisionError()],
    ['404 VFS_NODE_NOT_FOUND', new VfsNodeNotFoundError('/a')],
    ['409 VFS_IS_DIRECTORY', new VfsIsDirectoryError('/a')],
    ['409 VFS_ALREADY_EXISTS', new VfsAlreadyExistsError('/a')],
    ['409 VFS_REVISION_EXHAUSTED', new VfsRevisionExhaustedError()],
    ['412 VFS_PRECONDITION_FAILED', new VfsPreconditionFailedError('/a', null)],
    ['413 VFS_DELETE_LIMIT_EXCEEDED', new VfsDeleteLimitExceededError(5)],
    ['413 VFS_COPY_LIMIT_EXCEEDED', new VfsCopyLimitExceededError(5)],
    ['413 VFS_SNAPSHOT_LIMIT_EXCEEDED', new VfsSnapshotLimitExceededError()],
    ['413 VFS_QUOTA_EXCEEDED', new VfsQuotaExceededError('10', '11')],
    ['428 VFS_PRECONDITION_REQUIRED', new VfsPreconditionRequiredError()],
    ['499 경계', new CodedError('EDGE_499', 499)],
  ])('결정적 4xx DomainError는 저장 대상이다: %s', (_title, error) => {
    expect(isReplayableMutationError(error)).toBe(true);
  });

  // 전제: 스트리밍 본문 한도 초과와 선언 길이(Content-Length) 초과 413은 호출부가 fingerprint를
  // 만들기 전에 던지므로 분류기에 도달하지 않는다. 이 케이스는 분류기에 도달한 경우의 판정만 고정한다.
  it('분류기에 도달한 413 VFS_FILE_TOO_LARGE는 저장 대상이다(스트리밍·선언 길이 초과 413은 호출부가 fingerprint 전에 던져 분류기에 도달하지 않는다)', () => {
    expect(isReplayableMutationError(new VfsFileTooLargeError(1))).toBe(true);
  });

  it.each([
    ['401 인증 실패', new InvalidApiKeyError()],
    ['500 DomainError', new CodedError('BROKEN', 500)],
    ['503 DomainError', new CodedError('UNAVAILABLE', 503)],
    ['399 경계', new CodedError('EDGE_399', 399)],
    ['MUTATION_IN_PROGRESS', new CodedError('MUTATION_IN_PROGRESS', 409)],
    ['MUTATION_KEY_REUSED', new CodedError('MUTATION_KEY_REUSED', 409)],
    ['namespace 부재 404', new VfsNamespaceNotFoundError(randomUUID())],
    ['일반 Error', new Error('database unavailable')],
    ['status가 4xx인 일반 Error', Object.assign(new Error('fake'), { code: 'FAKE', status: 400 })],
    ['Error가 아닌 값', 'failure'],
    ['undefined', undefined],
  ])('저장하지 않는다: %s', (_title, error) => {
    expect(isReplayableMutationError(error)).toBe(false);
  });
});

describe('storeErrorReceipt', () => {
  const owner: ErrorReceiptOwner = {
    identity: { namespaceId: randomUUID(), scope: 'scope', key: randomUUID() },
    generation: 3,
    fingerprint: 'f'.repeat(64),
    method: 'POST',
    requestBodyBytes: 12,
  };

  function receipts(
    completeAfterRollback = jest.fn(async () => undefined),
    namespaceExists = jest.fn(async () => true),
  ) {
    return {
      repository: { completeAfterRollback, namespaceExists } as unknown as VfsMutationReceiptRepository,
      completeAfterRollback,
      namespaceExists,
    };
  }

  it('결정적 4xx를 독립 트랜잭션 완료로 저장하고 같은 응답을 반환한다', async () => {
    const { repository, completeAfterRollback } = receipts();
    const error = new VfsPreconditionFailedError('/a', null);

    const result = await storeErrorReceipt(repository, owner, error, 'req-1');

    expect(result).toEqual({
      status: 412,
      body: {
        code: 'VFS_PRECONDITION_FAILED',
        message: 'mutation 전제조건 불일치: /a',
        path: '/a',
        current: null,
        requestId: 'req-1',
      },
      headers: { 'x-request-id': 'req-1' },
    });
    expect(completeAfterRollback).toHaveBeenCalledWith(
      owner.identity,
      3,
      owner.fingerprint,
      'POST',
      result,
      12,
    );
  });

  it('저장 대상이 아닌 오류는 receipt를 완료하지 않고 그대로 다시 던진다', async () => {
    const { repository, completeAfterRollback } = receipts();
    const error = new Error('database unavailable');

    await expect(storeErrorReceipt(repository, owner, error, 'req-1')).rejects.toBe(error);
    expect(completeAfterRollback).not.toHaveBeenCalled();
  });

  it('fencing 실패(claim lost)는 응답 대신 완료 오류를 전파한다', async () => {
    const { repository, namespaceExists } = receipts(
      jest.fn(async () => {
        throw new Error('VFS mutation claim lost');
      }),
    );

    await expect(
      storeErrorReceipt(repository, owner, new VfsNodeNotFoundError('/a'), 'req-1'),
    ).rejects.toThrow('VFS mutation claim lost');
    expect(namespaceExists).toHaveBeenCalledWith(owner.identity.namespaceId);
  });

  it('fencing 실패 뒤 namespace가 삭제됐으면 NAMESPACE_NOT_FOUND를 반환한다', async () => {
    const { repository } = receipts(
      jest.fn(async () => {
        throw new Error('VFS mutation claim lost');
      }),
      jest.fn(async () => false),
    );

    await expect(
      storeErrorReceipt(repository, owner, new VfsNodeNotFoundError('/a'), 'req-1'),
    ).rejects.toMatchObject({
      code: 'NAMESPACE_NOT_FOUND',
      status: 404,
    });
  });
  it('claim lost 뒤 namespace 조회가 실패하면 원래 claim-lost 오류를 전파한다', async () => {
    const { repository, namespaceExists } = receipts(
      jest.fn(async () => {
        throw new Error('VFS mutation claim lost');
      }),
      jest.fn(async () => {
        throw new Error('database unavailable');
      }),
    );

    await expect(
      storeErrorReceipt(repository, owner, new VfsNodeNotFoundError('/a'), 'req-1'),
    ).rejects.toThrow('VFS mutation claim lost');
    expect(namespaceExists).toHaveBeenCalledWith(owner.identity.namespaceId);
  });

  it('claim lost가 아닌 receipt 완료 오류에서는 namespace를 조회하지 않는다', async () => {
    const { repository, namespaceExists } = receipts(
      jest.fn(async () => {
        throw new Error('receipt write failed');
      }),
    );

    await expect(
      storeErrorReceipt(repository, owner, new VfsNodeNotFoundError('/a'), 'req-1'),
    ).rejects.toThrow('receipt write failed');
    expect(namespaceExists).not.toHaveBeenCalled();
  });
});

describe('replayReceipt', () => {
  function receipt(method: string, fingerprint: string): VfsMutationReceiptEntity {
    const entity = new VfsMutationReceiptEntity();
    entity.method = method;
    entity.fingerprint = fingerprint;
    entity.responseStatus = 412;
    entity.responseBody = JSON.stringify({ code: 'VFS_PRECONDITION_FAILED', requestId: 'req-first' });
    entity.responseHeaders = JSON.stringify({ 'x-request-id': 'req-first' });
    return entity;
  }

  it('같은 method와 fingerprint면 최초 status/body/X-Request-Id를 재생한다', () => {
    expect(replayReceipt(receipt('POST', 'a'), 'POST', 'a', 'req-second')).toEqual({
      status: 412,
      body: { code: 'VFS_PRECONDITION_FAILED', requestId: 'req-first' },
      headers: { 'x-request-id': 'req-first' },
    });
  });

  it.each([
    ['fingerprint', receipt('POST', 'a'), 'POST', 'b'],
    ['method', receipt('PUT', 'a'), 'POST', 'a'],
  ])('%s가 다르면 MUTATION_KEY_REUSED를 반환한다', (_title, entity, method, fingerprint) => {
    expect(replayReceipt(entity, method, fingerprint, 'req-second')).toEqual({
      status: 409,
      body: {
        code: 'MUTATION_KEY_REUSED',
        message: '다른 요청에 사용한 mutation key',
        requestId: 'req-second',
      },
      headers: { 'x-request-id': 'req-second' },
    });
  });
});

describe('busyResponse', () => {
  it('진행 중 claim은 Retry-After와 함께 409 MUTATION_IN_PROGRESS를 반환한다', () => {
    expect(busyResponse(7, 'req-1')).toEqual({
      status: 409,
      body: { code: 'MUTATION_IN_PROGRESS', message: 'mutation 처리 중', requestId: 'req-1' },
      headers: { 'retry-after': '7', 'x-request-id': 'req-1' },
    });
  });
});
