import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { IdempotencyReceiptRetentionRepository } from '../../src/persistence/idempotency-receipt-retention.repository.js';

export function runIdempotencyReceiptRetentionSharedTests(
  get: () => {
    readonly dataSource: DataSource;
    readonly repository: IdempotencyReceiptRetentionRepository;
    readonly sqlite: boolean;
  },
): void {
  async function insert(key: string, ageDays: number): Promise<void> {
    const { dataSource, sqlite } = get();
    await dataSource.query(
      sqlite
        ? `INSERT INTO idempotency_key (key, request_hash, response_status, response_body, created_at)
           VALUES (?, ?, 201, '{}', datetime('now', ?))`
        : `INSERT INTO idempotency_key (key, request_hash, response_status, response_body, created_at)
           VALUES ($1, $2, 201, '{}', now() - ($3::int * interval '1 day'))`,
      sqlite ? [key, 'a'.repeat(64), `-${ageDays} days`] : [key, 'a'.repeat(64), ageDays],
    );
  }

  async function exists(key: string): Promise<boolean> {
    const { dataSource, sqlite } = get();
    const rows = (await dataSource.query(
      sqlite
        ? 'SELECT 1 AS v FROM idempotency_key WHERE key = ?'
        : 'SELECT 1 AS v FROM idempotency_key WHERE key = $1',
      [key],
    )) as unknown[];
    return rows.length > 0;
  }

  beforeEach(async () => {
    await get().dataSource.query('DELETE FROM idempotency_key');
  });

  it('보존 기간을 넘긴 receipt만 지우고 최근 receipt는 남긴다', async () => {
    const old = `old-${randomUUID()}`;
    const edge = `edge-${randomUUID()}`;
    const fresh = `fresh-${randomUUID()}`;
    await insert(old, 31);
    await insert(edge, 29);
    await insert(fresh, 0);

    expect(await get().repository.pruneExpiredBatch(30, 500)).toBe(1);

    expect(await exists(old)).toBe(false);
    expect(await exists(edge)).toBe(true);
    expect(await exists(fresh)).toBe(true);
  });

  it('한 호출에 batch 크기만큼만 지우고 오래된 것부터 지운다', async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `batch-${i}-${randomUUID()}`);
    for (const [index, key] of keys.entries()) await insert(key, 100 - index);

    expect(await get().repository.pruneExpiredBatch(30, 2)).toBe(2);
    expect(await exists(keys[0])).toBe(false);
    expect(await exists(keys[1])).toBe(false);
    expect(await exists(keys[2])).toBe(true);

    expect(await get().repository.pruneExpiredBatch(30, 2)).toBe(2);
    expect(await get().repository.pruneExpiredBatch(30, 2)).toBe(1);
    expect(await get().repository.pruneExpiredBatch(30, 2)).toBe(0);
  });

  it('만료 receipt가 없으면 0이다', async () => {
    await insert(`fresh-${randomUUID()}`, 1);
    expect(await get().repository.pruneExpiredBatch(30, 500)).toBe(0);
  });

  it('잘못된 인자를 거부한다', async () => {
    await expect(get().repository.pruneExpiredBatch(0, 500)).rejects.toThrow();
    await expect(get().repository.pruneExpiredBatch(30, 0)).rejects.toThrow();
    await expect(get().repository.pruneExpiredBatch(30, 1001)).rejects.toThrow();
  });
}
