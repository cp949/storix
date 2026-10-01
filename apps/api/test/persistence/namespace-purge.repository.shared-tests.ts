import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import type {
  NamespacePurgeCursor,
  NamespacePurgeRepository,
} from '../../src/persistence/namespace-purge.repository.js';

interface Context {
  readonly dataSource: DataSource;
  readonly repository: NamespacePurgeRepository;
  readonly sqlite: boolean;
}

export function runNamespacePurgeSharedTests(get: () => Context): void {
  const ph = (n: number) => (get().sqlite ? '?' : `$${n}`);
  const run = (sql: string, params: unknown[] = []) => get().dataSource.query(sql, params);

  /** 삭제가 끝난 namespace를 흉내 낸다: root 제거, DELETED, COMPLETED operation과 삭제 receipt. */
  async function completedDeletion(
    ageDays: number,
    phase = 'COMPLETED',
    status = 'DELETED',
  ): Promise<string> {
    const { dataSource, sqlite } = get();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      `purge-${randomUUID()}`,
    );
    await run(`DELETE FROM vfs_node WHERE namespace_id = ${ph(1)}`, [namespace.id]);
    await run(`UPDATE namespace SET status = ${ph(1)} WHERE id = ${ph(2)}`, [status, namespace.id]);
    const completed = phase === 'COMPLETED';
    await run(
      sqlite
        ? `INSERT INTO namespace_deletion (namespace_id, phase, requested_at, updated_at, completed_at)
           VALUES (?, ?, datetime('now', ?), datetime('now', ?), ${completed ? "datetime('now', ?)" : 'NULL'})`
        : `INSERT INTO namespace_deletion (namespace_id, phase, requested_at, updated_at, completed_at)
           VALUES ($1, $2, now() - ($3::int * interval '1 day'), now() - ($3::int * interval '1 day'),
                   ${completed ? "now() - ($3::int * interval '1 day')" : 'NULL'})`,
      sqlite
        ? completed
          ? [namespace.id, phase, `-${ageDays} days`, `-${ageDays} days`, `-${ageDays} days`]
          : [namespace.id, phase, `-${ageDays} days`, `-${ageDays} days`]
        : [namespace.id, phase, ageDays],
    );
    await run(
      `INSERT INTO namespace_deletion_receipt (namespace_id, key_hash, response_status, response_body)
       VALUES (${ph(1)}, ${ph(2)}, 202, '{}')`,
      [namespace.id, 'b'.repeat(64)],
    );
    return namespace.id;
  }

  async function namespaceExists(id: string): Promise<boolean> {
    return ((await run(`SELECT 1 AS v FROM namespace WHERE id = ${ph(1)}`, [id])) as unknown[]).length > 0;
  }

  async function count(table: string, id: string): Promise<number> {
    const column = table === 'namespace' ? 'id' : 'namespace_id';
    return ((await run(`SELECT 1 AS v FROM ${table} WHERE ${column} = ${ph(1)}`, [id])) as unknown[]).length;
  }

  async function drain(days: number, limit: number): Promise<{ purged: number; skipped: number }> {
    let cursor: NamespacePurgeCursor | null = null;
    let purged = 0;
    let skipped = 0;
    for (let guard = 0; guard < 100; guard++) {
      const page: Awaited<ReturnType<NamespacePurgeRepository['purgeNext']>> =
        await get().repository.purgeNext(days, cursor, limit);
      purged += page.purged;
      skipped += page.skipped;
      if (page.next === null) return { purged, skipped };
      cursor = page.next;
    }
    throw new Error('cursor가 끝나지 않는다');
  }

  beforeEach(async () => {
    // 이전 테스트가 남긴 후보가 섞이지 않게 비운다.
    await run('DELETE FROM namespace_deletion_receipt');
    await run('DELETE FROM namespace_deletion');
  });

  it('보존 기간을 넘긴 완료 namespace의 행을 FK 순서대로 모두 지운다', async () => {
    const id = await completedDeletion(31);
    const result = await drain(30, 100);

    expect(result.purged).toBe(1);
    expect(await namespaceExists(id)).toBe(false);
    expect(await count('namespace_deletion', id)).toBe(0);
    expect(await count('namespace_deletion_receipt', id)).toBe(0);
  });

  it('보존 기간 안의 완료 namespace와 완료되지 않은 operation은 지우지 않는다', async () => {
    const recent = await completedDeletion(29);
    const deleting = await completedDeletion(40, 'OBJECTS', 'DELETING');
    const result = await drain(30, 100);

    expect(result.purged).toBe(0);
    expect(await namespaceExists(recent)).toBe(true);
    expect(await namespaceExists(deleting)).toBe(true);
  });

  it('남은 참조 행이 있는 namespace는 건너뛰고 나머지를 지운다', async () => {
    const blocked = await completedDeletion(40);
    const clean = await completedDeletion(35);
    await run(
      `INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count)
       VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, 1, 'text/plain', ${ph(4)}, 0)`,
      [randomUUID(), blocked, `blobs/ab/${randomUUID()}`, 'c'.repeat(64)],
    );

    const result = await drain(30, 100);

    expect(result).toEqual({ purged: 1, skipped: 1 });
    expect(await namespaceExists(blocked)).toBe(true);
    expect(await namespaceExists(clean)).toBe(false);
    await run(`DELETE FROM blob WHERE namespace_id = ${ph(1)}`, [blocked]);
  });

  it('cursor를 이어 page마다 지우고 같은 행을 다시 읽지 않는다', async () => {
    const ids = [];
    for (let age = 50; age > 45; age--) ids.push(await completedDeletion(age));

    const first = await get().repository.purgeNext(30, null, 2);
    expect(first.examined).toBe(2);
    expect(first.purged).toBe(2);
    expect(first.next).not.toBeNull();
    const second = await get().repository.purgeNext(30, first.next, 2);
    expect(second.purged).toBe(2);
    const third = await get().repository.purgeNext(30, second.next, 2);
    expect(third).toMatchObject({ purged: 1, next: null });
    for (const id of ids) expect(await namespaceExists(id)).toBe(false);
  });

  it('한 page의 많은 namespace를 한 번에 지운다', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await completedDeletion(40 + (i % 5)));
    const result = await get().repository.purgeNext(30, null, 100);
    expect(result).toMatchObject({ purged: 25, skipped: 0, examined: 25, next: null });
    for (const id of ids) expect(await namespaceExists(id)).toBe(false);
  });

  it('삭제한 namespace의 이름을 다시 쓸 수 있고 생성 receipt는 건드리지 않는다', async () => {
    const { dataSource } = get();
    const name = `purge-reuse-${randomUUID()}`;
    const repo = new NamespaceProvisioningRepository(dataSource);
    const first = await repo.createWithRoot(name, 'NONE', 'PRIVATE', null, {
      key: `receipt-${name}`,
      requestHash: 'd'.repeat(64),
      responseStatus: 201,
      responseBody: () => ({}),
    });
    await run(`DELETE FROM vfs_node WHERE namespace_id = ${ph(1)}`, [first.id]);
    await run(`UPDATE namespace SET status = 'DELETED' WHERE id = ${ph(1)}`, [first.id]);
    await run(
      get().sqlite
        ? `INSERT INTO namespace_deletion (namespace_id, phase, requested_at, updated_at, completed_at)
           VALUES (?, 'COMPLETED', datetime('now', '-40 days'), datetime('now', '-40 days'), datetime('now', '-40 days'))`
        : `INSERT INTO namespace_deletion (namespace_id, phase, requested_at, updated_at, completed_at)
           VALUES ($1, 'COMPLETED', now() - interval '40 days', now() - interval '40 days', now() - interval '40 days')`,
      [first.id],
    );

    await drain(30, 100);

    expect((await repo.createWithRoot(name)).id).not.toBe(first.id);
    expect(
      (
        (await run(`SELECT 1 AS v FROM idempotency_key WHERE key = ${ph(1)}`, [
          `receipt-${name}`,
        ])) as unknown[]
      ).length,
    ).toBe(1);
  });

  it('잘못된 인자를 거부한다', async () => {
    await expect(get().repository.purgeNext(0, null, 10)).rejects.toThrow();
    await expect(get().repository.purgeNext(30, null, 0)).rejects.toThrow();
    await expect(get().repository.purgeNext(30, null, 501)).rejects.toThrow();
  });
}
