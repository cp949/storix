import type { EntityManager } from 'typeorm';
import type { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { withExactNamespaceBigints } from '../../src/persistence/namespace-bigint-read.js';
import { StorageFailureError } from '../../src/common/storage-failure.errors.js';

const BIGINT = '9007199254740993';

function namespace(id: string): NamespaceEntity {
  return { id, name: id, liveFileByteCount: '0' } as NamespaceEntity;
}

function manager(query: (...args: unknown[]) => Promise<unknown>, type: 'better-sqlite3' | 'postgres' = 'better-sqlite3'): EntityManager {
  return { connection: { options: { type } }, query } as unknown as EntityManager;
}

describe('namespace 정확한 int64 조회', () => {
  it.each(['better-sqlite3', 'postgres'] as const)('%s의 많은 ID를 안전하게 나눠 조회하고 입력 순서와 원문 숫자를 보존한다', async (type) => {
    const namespaces = Array.from({ length: 1001 }, (_, index) => namespace(`id-${index}`));
    const batches: string[][] = [];
    const query = async (_sql: unknown, ids: unknown) => {
      const batch = ids as string[];
      batches.push(batch);
      return batch.slice().reverse().map((id) => ({
        id, liveFileByteCount: (BigInt(BIGINT) + BigInt(id.slice(3))).toString(),
      }));
    };

    const result = await withExactNamespaceBigints(manager(query, type), namespaces);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.length <= 900)).toBe(true);
    expect(batches.flat()).toEqual(namespaces.map(({ id }) => id));
    expect(result.map(({ id }) => id)).toEqual(namespaces.map(({ id }) => id));
    expect(result.map(({ liveFileByteCount }) => liveFileByteCount))
      .toEqual(namespaces.map((_, index) => (BigInt(BIGINT) + BigInt(index)).toString()));
  });

  it.each([
    [{ driverError: { code: '08006' } }, 'STORAGE_UNAVAILABLE', 503],
    [{ code: 'SQLITE_BUSY' }, 'STORAGE_UNAVAILABLE', 503],
    [{ driverError: { code: '53100' } }, 'STORAGE_FAILURE', 500],
  ] as const)('두 번째 DB 조회의 저장 오류 %p를 %s로 분류한다', async (failure, code, status) => {
    const query = async () => { throw failure; };
    await expect(withExactNamespaceBigints(manager(query), [namespace('id')]))
      .rejects.toMatchObject({ code, status });
  });

  it('이미 분류된 도메인 오류를 그대로 전달한다', async () => {
    const failure = new StorageFailureError();
    const query = async () => { throw failure; };
    await expect(withExactNamespaceBigints(manager(query), [namespace('id')])).rejects.toBe(failure);
  });
});
