/** 좁은 dependency double로 multipart claim 수명과 abort 결과를 검증한다. 규칙은 api ADR-0045다. */
import { jest } from '@jest/globals';
import { Logger, type LoggerService } from '@nestjs/common';
import { OwnedMultipartCleanup } from '../../src/jobs/owned-multipart-cleanup.js';
import type { StoragePutGcClaimResult } from '../../src/persistence/storage-put-ownership.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import type { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';

type Storage = Pick<BlobStorage, 'abortIncompleteUpload'>;
type Ownership = Pick<StoragePutOwnershipRepository, 'claimForGc' | 'releaseGcClaim'>;

// abort 진입 신호로 claim 유지 구간을 확인한다.
// 성공·보류·오류별 반환값과 로그를 저장소 double로 고정한다.
describe('OwnedMultipartCleanup', () => {
  const logs = { warn: jest.fn(), error: jest.fn() };
  const key = 'blobs/ns/file';
  const uploadId = 'upload-1';
  const executionId = 'gc-1';

  beforeEach(() => {
    jest.clearAllMocks();
    Logger.overrideLogger(logs as unknown as LoggerService);
  });

  afterAll(() => Logger.overrideLogger(false));

  /** claim 결과를 지정할 수 있는 소유권 저장소 double을 만든다. */
  function makeOwnership(result: StoragePutGcClaimResult = { kind: 'claimed' }) {
    const claimForGc = jest.fn<Ownership['claimForGc']>().mockResolvedValue(result);
    const releaseGcClaim = jest.fn<Ownership['releaseGcClaim']>().mockResolvedValue(undefined);
    return { value: { claimForGc, releaseGcClaim }, claimForGc, releaseGcClaim };
  }

  /** abort 호출을 관찰할 수 있는 저장소 double을 만든다. */
  function makeStorage() {
    const abortIncompleteUpload = jest.fn<Storage['abortIncompleteUpload']>().mockResolvedValue(undefined);
    return { value: { abortIncompleteUpload }, abortIncompleteUpload };
  }

  it('ownership dependency가 없으면 abort를 보류하고 경고한다', async () => {
    const storage = makeStorage();
    const cleanup = new OwnedMultipartCleanup(storage.value);

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(false);

    expect(storage.abortIncompleteUpload).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(
      `소유권 확인기가 없어 미완료 multipart upload abort 보류: ${key} (${uploadId})`,
      'GcJob',
    );
  });

  it('실행 식별자가 비어 있으면 abort를 보류하고 경고한다', async () => {
    const storage = makeStorage();
    const ownership = makeOwnership();
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, '');

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(false);

    expect(ownership.claimForGc).not.toHaveBeenCalled();
    expect(storage.abortIncompleteUpload).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(
      `소유권 확인기가 없어 미완료 multipart upload abort 보류: ${key} (${uploadId})`,
      'GcJob',
    );
  });

  it.each(['unknown', 'protected'] as const)('%s claim은 abort 없이 보류한다', async (kind) => {
    const storage = makeStorage();
    const ownership = makeOwnership({ kind });
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, executionId);

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(false);

    expect(storage.abortIncompleteUpload).not.toHaveBeenCalled();
    expect(ownership.releaseGcClaim).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(
      `multipart 소유권 ${kind} 상태로 abort 보류: ${key} (${uploadId})`,
      'GcJob',
    );
  });

  it('claim 조회 예외를 기록하고 abort하지 않는다', async () => {
    const storage = makeStorage();
    const ownership = makeOwnership();
    const error = new Error('claim failed');
    ownership.claimForGc.mockRejectedValue(error);
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, executionId);

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(false);

    expect(storage.abortIncompleteUpload).not.toHaveBeenCalled();
    expect(ownership.releaseGcClaim).not.toHaveBeenCalled();
    expect(logs.error).toHaveBeenCalledWith(
      `multipart 소유권 확인 또는 abort 실패: ${key} (${uploadId})`,
      error,
      'GcJob',
    );
  });

  it('claim을 얻으면 같은 key와 claimId로 abort 후 해제한다', async () => {
    const storage = makeStorage();
    const ownership = makeOwnership();
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, executionId);

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(true);

    const claimId = ownership.claimForGc.mock.calls[0][1];
    expect(ownership.claimForGc).toHaveBeenCalledWith(key, claimId, executionId);
    expect(storage.abortIncompleteUpload).toHaveBeenCalledWith(key, uploadId);
    expect(ownership.releaseGcClaim).toHaveBeenCalledWith(key, claimId);
  });

  it('abort 실패를 기록하고 자기 claim을 해제한다', async () => {
    const storage = makeStorage();
    const error = new Error('abort failed');
    storage.abortIncompleteUpload.mockRejectedValue(error);
    const ownership = makeOwnership();
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, executionId);

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(false);

    const claimId = ownership.claimForGc.mock.calls[0][1];
    expect(ownership.releaseGcClaim).toHaveBeenCalledWith(key, claimId);
    expect(logs.error).toHaveBeenCalledWith(
      `multipart 소유권 확인 또는 abort 실패: ${key} (${uploadId})`,
      error,
      'GcJob',
    );
  });

  it('release 실패가 abort 성공 반환값을 바꾸지 않고 claim 오류를 기록한다', async () => {
    const storage = makeStorage();
    const ownership = makeOwnership();
    const error = new Error('release failed');
    ownership.releaseGcClaim.mockRejectedValue(error);
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, executionId);

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(true);

    const claimId = ownership.claimForGc.mock.calls[0][1];
    expect(ownership.releaseGcClaim).toHaveBeenCalledWith(key, claimId);
    expect(logs.error).toHaveBeenCalledWith(
      `multipart GC claim 해제 실패: ${key} (${claimId})`,
      error,
      'GcJob',
    );
  });

  it('abort와 release가 모두 실패해도 두 오류를 기록한다', async () => {
    const storage = makeStorage();
    const abortError = new Error('abort failed');
    storage.abortIncompleteUpload.mockRejectedValue(abortError);
    const ownership = makeOwnership();
    const releaseError = new Error('release failed');
    ownership.releaseGcClaim.mockRejectedValue(releaseError);
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, executionId);

    await expect(cleanup.abort(key, uploadId)).resolves.toBe(false);

    const claimId = ownership.claimForGc.mock.calls[0][1];
    expect(logs.error).toHaveBeenCalledTimes(2);
    expect(logs.error).toHaveBeenNthCalledWith(
      1,
      `multipart 소유권 확인 또는 abort 실패: ${key} (${uploadId})`,
      abortError,
      'GcJob',
    );
    expect(logs.error).toHaveBeenNthCalledWith(
      2,
      `multipart GC claim 해제 실패: ${key} (${claimId})`,
      releaseError,
      'GcJob',
    );
  });

  it('abort Promise가 정착할 때까지 claim을 유지한다', async () => {
    const storage = makeStorage();
    let resolveAbort!: () => void;
    let signalAbortStarted!: () => void;
    const abortStarted = new Promise<void>((resolve) => (signalAbortStarted = resolve));
    storage.abortIncompleteUpload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAbort = resolve;
          signalAbortStarted();
        }),
    );
    const ownership = makeOwnership();
    const cleanup = new OwnedMultipartCleanup(storage.value, ownership.value, executionId);

    const result = cleanup.abort(key, uploadId);
    await abortStarted;

    try {
      expect(ownership.releaseGcClaim).not.toHaveBeenCalled();
    } finally {
      resolveAbort();
      await result;
    }
    await expect(result).resolves.toBe(true);

    const claimId = ownership.claimForGc.mock.calls[0][1];
    expect(ownership.releaseGcClaim).toHaveBeenCalledWith(key, claimId);
  });
});
