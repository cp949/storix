import { jest } from '@jest/globals';
import type { DataSource } from 'typeorm';
import { findMissingNamespaceIds } from '../../src/capability/namespace-existence.js';

function fakeDataSource(type: 'postgres' | 'better-sqlite3', existing: Set<string>) {
  const query = jest.fn(async (_sql: string, params: unknown[]) => {
    const ids = type === 'postgres' ? (params[0] as string[]) : (params as string[]);
    return ids.filter((id) => existing.has(id)).map((id) => ({ id }));
  });
  return { dataSource: { options: { type }, query } as unknown as DataSource, query };
}

describe('findMissingNamespaceIds', () => {
  const ids = Array.from(
    { length: 2500 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );

  it('PostgreSQL은 id 수와 무관하게 한 번의 질의로 조회한다', async () => {
    const { dataSource, query } = fakeDataSource('postgres', new Set(ids.slice(1)));
    expect(await findMissingNamespaceIds(dataSource, ids)).toEqual([ids[0]]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('SQLite는 1000개 청크로 나눠 조회한다', async () => {
    const { dataSource, query } = fakeDataSource('better-sqlite3', new Set(ids));
    expect(await findMissingNamespaceIds(dataSource, ids)).toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('빈 목록은 질의하지 않는다', async () => {
    const { dataSource, query } = fakeDataSource('postgres', new Set());
    expect(await findMissingNamespaceIds(dataSource, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('없는 id를 입력 순서대로 모두 돌려준다', async () => {
    const { dataSource } = fakeDataSource('postgres', new Set([ids[1]]));
    expect(await findMissingNamespaceIds(dataSource, ids.slice(0, 3))).toEqual([ids[0], ids[2]]);
  });
});
