/** 가짜 DB·storage로 PUT 시작 전 등록과 성공·실패 정착을 검증한다. 규칙은 api ADR-0045다. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { PutProtectedBlobStorage } from '../../src/storage/put-protected-blob-storage.js';
import type { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';

// 가짜 storage와 repository로 시작 순서·등록 실패 차단·Promise 정착 기록을 확인한다.
describe('PutProtectedBlobStorage', () => {
  const source = Readable.from(['content']);
  let raw: Pick<BlobStorage, 'put'>;
  let rawPut: jest.MockedFunction<BlobStorage['put']>;
  let ownership: Pick<StoragePutOwnershipRepository, 'beginPut' | 'settlePut'>;
  let beginPut: jest.MockedFunction<StoragePutOwnershipRepository['beginPut']>;
  let settlePut: jest.MockedFunction<StoragePutOwnershipRepository['settlePut']>;
  let storage: PutProtectedBlobStorage;

  beforeEach(() => {
    rawPut = jest.fn<BlobStorage['put']>().mockResolvedValue(undefined);
    raw = { put: rawPut };
    beginPut = jest.fn<StoragePutOwnershipRepository['beginPut']>().mockResolvedValue('attempt-id');
    settlePut = jest.fn<StoragePutOwnershipRepository['settlePut']>().mockResolvedValue(undefined);
    ownership = { beginPut, settlePut };
    storage = new PutProtectedBlobStorage(raw as unknown as BlobStorage, ownership as never, 'execution-id');
  });

  it('소유권 기록을 확정한 뒤 raw PUT를 시작한다', async () => {
    const order: string[] = [];
    beginPut.mockImplementation(async () => {
      order.push('registered');
      return 'attempt-id';
    });
    rawPut.mockImplementation(async () => {
      order.push('put');
    });

    await storage.put('blobs/key', source);

    expect(order).toEqual(['registered', 'put']);
    expect(settlePut).toHaveBeenCalledWith('attempt-id');
  });

  it('소유권 기록에 실패하면 raw PUT를 시작하지 않는다', async () => {
    beginPut.mockRejectedValue(new Error('database unavailable'));

    await expect(storage.put('blobs/key', source)).rejects.toThrow('database unavailable');
    expect(rawPut).not.toHaveBeenCalled();
  });

  it('raw PUT 실패 뒤에도 시도 정착을 기록하고 원본 오류를 다시 던진다', async () => {
    rawPut.mockRejectedValue(new Error('storage unavailable'));

    await expect(storage.put('blobs/key', source)).rejects.toThrow('storage unavailable');
    expect(settlePut).toHaveBeenCalledWith('attempt-id');
  });
});
