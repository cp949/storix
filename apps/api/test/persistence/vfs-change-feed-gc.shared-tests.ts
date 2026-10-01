import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import {
  type ChangeFeedPruneCursor,
  type ChangeFeedPruneResult,
  VfsChangeFeedRetentionRepository,
} from '../../src/persistence/vfs-change-feed-retention.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsChangeCursorExpiredError } from '../../src/vfs/vfs.errors.js';

interface Context {
  readonly dataSource: DataSource;
  readonly nodes: VfsNodeRepository;
  readonly retention: VfsChangeFeedRetentionRepository;
  readonly sqlite: boolean;
}

export function runVfsChangeFeedGcSharedTests(get: () => Context): void {
  // 후보 선택은 DB 전체의 만료 이벤트를 대상으로 하므로 앞선 테스트가 남긴 이벤트가 섞이지 않게 비운다.
  beforeEach(async () => {
    await get().dataSource.query('DELETE FROM vfs_change_event');
    await get().dataSource.query('DELETE FROM vfs_change_feed_state');
  });

  async function fixture() {
    const c = get();
    const namespace = await new NamespaceProvisioningRepository(c.dataSource).createWithRoot(
      `feed-gc-${randomUUID()}`,
    );
    const root = await c.nodes.getRoot(namespace.id);
    if (!root) throw new Error('root missing');
    await c.nodes.createChangeFeedCheckpoint(namespace.id, root.id);
    const insert = async (sequence: number, age: boolean | number) => {
      const days = typeof age === 'number' ? age : age ? 31 : 0;
      const args = c.sqlite ? '(?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ' : '($1, $2, $3, 0, 1, $4, $5, $6, $7, $8, ';
      const time = c.sqlite
        ? days > 0
          ? `datetime('now', '-${days} days')`
          : "datetime('now')"
        : days > 0
          ? `CURRENT_TIMESTAMP - INTERVAL '${days} days'`
          : 'CURRENT_TIMESTAMP';
      await c.dataSource.query(
        `INSERT INTO vfs_change_event
        (namespace_id, sequence, operation_id, operation_index, operation_count,
         kind, node_id, node_type, path, revision, occurred_at)
        VALUES ${args}${time})`,
        [
          namespace.id,
          String(sequence),
          randomUUID(),
          'created',
          randomUUID(),
          'DIRECTORY',
          `/event-${sequence}`,
          `r${sequence}`,
        ],
      );
      await c.dataSource.query(
        c.sqlite
          ? 'UPDATE vfs_change_feed_state SET last_sequence = ? WHERE namespace_id = ?'
          : 'UPDATE vfs_change_feed_state SET last_sequence = $1 WHERE namespace_id = $2',
        [String(sequence), namespace.id],
      );
    };
    const state = () => c.nodes.getChangeFeedState(namespace.id);
    const events = () => c.nodes.listChangeFeedEvents(namespace.id, '0', 1001);
    return { ...c, id: namespace.id, insert, state, events };
  }

  it('DB cutoff, 배치, 재실행은 만료된 연속 접두 구간만 제거한다', async () => {
    const c = await fixture();
    await c.insert(1, true);
    await c.insert(2, true);
    await c.insert(3, false);
    await c.insert(4, true);
    expect((await c.retention.pruneNext(30, 1, null)).deleted).toBe(1);
    expect((await c.state())?.prunedThrough).toBe('1');
    expect((await c.retention.pruneNext(30, 1, null)).deleted).toBe(1);
    expect((await c.state())?.prunedThrough).toBe('2');
    expect((await c.retention.pruneNext(30, 2, null)).deleted).toBe(0);
    expect((await c.events()).map((event) => event.sequence)).toEqual(['3', '4']);
    const page = await c.nodes.readChangeFeedPage(c.id, 10, (state) => {
      expect(state?.prunedThrough).toBe('2');
      return '2';
    });
    expect(page.events.map((event) => event.sequence)).toEqual(['3', '4']);
    await c.dataSource.query(
      c.sqlite
        ? "UPDATE vfs_change_event SET occurred_at = datetime('now', '-31 days') WHERE namespace_id = ? AND sequence = 3"
        : "UPDATE vfs_change_event SET occurred_at = CURRENT_TIMESTAMP - INTERVAL '31 days' WHERE namespace_id = $1 AND sequence = 3",
      [c.id],
    );
    expect((await c.retention.pruneNext(30, 2, null)).deleted).toBe(2);
    expect((await c.retention.pruneNext(30, 2, null)).deleted).toBe(0);
    expect((await c.state())?.prunedThrough).toBe('4');
    expect((await c.state())?.lastSequence).toBe('4');
    expect(await c.events()).toEqual([]);
  });

  it('선두가 유효한 namespace의 만료 후속 이벤트는 건너뛰고 선두가 만료된 namespace를 정리한다', async () => {
    const blocked = await fixture();
    await blocked.insert(1, false);
    await blocked.insert(2, 90);
    await blocked.insert(3, 90);
    const due = await fixture();
    await due.insert(1, true);
    await due.insert(2, true);

    const first = await due.retention.pruneNext(30, 500, null);
    expect(first.deleted).toBe(2);
    expect((await due.state())?.prunedThrough).toBe('2');
    expect((await blocked.state())?.prunedThrough).toBe('0');
    expect((await blocked.events()).map((event) => event.sequence)).toEqual(['1', '2', '3']);

    let cursor = first.next;
    let deleted = 0;
    while (cursor !== null) {
      const result = await due.retention.pruneNext(30, 500, cursor);
      deleted += result.deleted;
      cursor = result.next;
    }
    expect(deleted).toBe(0);
    expect((await blocked.events()).map((event) => event.sequence)).toEqual(['1', '2', '3']);
  });

  it('page 한도보다 많은 막힌 이벤트 뒤의 후보도 cursor를 이어 호출하면 정리한다', async () => {
    const blocked = await fixture();
    await blocked.insert(1, false);
    for (let sequence = 2; sequence <= 7; sequence++) await blocked.insert(sequence, 90);
    const due = await fixture();
    await due.insert(1, true);

    let cursor: ChangeFeedPruneCursor | null = null;
    let deleted = 0;
    let calls = 0;
    do {
      const result: ChangeFeedPruneResult = await due.retention.pruneNext(30, 500, cursor, 2);
      expect(result.examined).toBeLessThanOrEqual(2);
      deleted += result.deleted;
      cursor = result.next;
      calls++;
    } while (cursor !== null && calls < 20);
    expect(cursor).toBeNull();
    expect(deleted).toBe(1);
    expect((await due.state())?.prunedThrough).toBe('1');
    expect((await blocked.events()).length).toBe(7);
  });

  it('batch보다 긴 만료 prefix는 cursor를 이어 호출하면 모두 정리하고 경계가 끝까지 전진한다', async () => {
    const c = await fixture();
    for (let sequence = 1; sequence <= 25; sequence++) await c.insert(sequence, true);
    let cursor: ChangeFeedPruneCursor | null = null;
    let deleted = 0;
    let calls = 0;
    do {
      const result: ChangeFeedPruneResult = await c.retention.pruneNext(30, 10, cursor);
      deleted += result.deleted;
      cursor = result.next;
      calls++;
    } while (cursor !== null && calls < 20);
    expect(cursor).toBeNull();
    expect(deleted).toBe(25);
    expect((await c.state())?.prunedThrough).toBe('25');
    expect(await c.events()).toEqual([]);
  });

  it('한 page 안에서 선두가 만료된 namespace 여러 개를 한 번의 호출로 정리한다', async () => {
    const first = await fixture();
    await first.insert(1, 40);
    await first.insert(2, 40);
    const second = await fixture();
    await second.insert(1, 35);
    const third = await fixture();
    await third.insert(1, false);

    const result = await first.retention.pruneNext(30, 500, null);
    expect(result).toMatchObject({ deleted: 3, examined: 3, next: null });
    expect((await first.state())?.prunedThrough).toBe('2');
    expect((await second.state())?.prunedThrough).toBe('1');
    expect((await third.events()).map((event) => event.sequence)).toEqual(['1']);
  });

  it('만료 이벤트가 없으면 아무것도 읽지 않고 next가 null이다', async () => {
    const c = await fixture();
    await c.insert(1, false);
    expect(await c.retention.pruneNext(30, 500, null)).toEqual({ deleted: 0, examined: 0, next: null });
  });

  it('PostgreSQL에서 다른 트랜잭션이 잠근 후보는 건너뛰고 다음 후보를 정리한다', async () => {
    if (get().sqlite) return;
    const locked = await fixture();
    await locked.insert(1, 40);
    const free = await fixture();
    await free.insert(1, 35);
    const runner = locked.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query('SELECT 1 FROM vfs_change_feed_state WHERE namespace_id = $1 FOR UPDATE', [
        locked.id,
      ]);
      const result = await free.retention.pruneNext(30, 500, null);
      expect(result.deleted).toBe(1);
      expect((await locked.state())?.prunedThrough).toBe('0');
      expect((await free.state())?.prunedThrough).toBe('1');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    expect((await locked.retention.pruneNext(30, 500, null)).deleted).toBe(1);
  });

  it('시퀀스 1~12를 숫자 순서로 한 건씩 정리해 경계가 12까지 전진한다', async () => {
    const c = await fixture();
    for (let sequence = 1; sequence <= 12; sequence++) await c.insert(sequence, true);
    for (let sequence = 1; sequence <= 12; sequence++) {
      expect((await c.retention.pruneNext(30, 1, null)).deleted).toBe(1);
      expect((await c.state())?.prunedThrough).toBe(String(sequence));
    }
    expect((await c.retention.pruneNext(30, 1, null)).deleted).toBe(0);
    expect((await c.state())?.lastSequence).toBe('12');
    expect(await c.events()).toEqual([]);
  });

  it('페이지 state 조회와 GC 사이의 경합은 일관된 페이지 또는 만료 경계로 끝난다', async () => {
    const c = await fixture();
    await c.insert(1, true);
    await c.insert(2, true);
    let entered!: () => void;
    let release!: () => void;
    const stateRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pagePromise = c.nodes.readChangeFeedPage(c.id, 3, async () => {
      entered();
      await resume;
      return '0';
    });
    await stateRead;
    const gcPromise = c.retention.pruneNext(30, 2, null).then((result) => result.deleted);
    if (!c.sqlite) expect(await gcPromise).toBe(2);
    release();
    const page = await pagePromise;
    expect(page.events.map((event) => event.sequence)).toEqual(['1', '2']);
    if (c.sqlite) expect(await gcPromise).toBe(2);
    expect((await c.state())?.prunedThrough).toBe('2');
    await expect(
      c.nodes.readChangeFeedPage(c.id, 3, (state) => {
        if (0n < BigInt(state!.prunedThrough)) throw new VfsChangeCursorExpiredError();
        return '0';
      }),
    ).rejects.toBeInstanceOf(VfsChangeCursorExpiredError);
    expect(
      (
        await c.nodes.readChangeFeedPage(c.id, 3, (state) => {
          expect(state?.prunedThrough).toBe('2');
          return '2';
        })
      ).events,
    ).toEqual([]);
  });

  it('namespace 삭제는 이벤트, 상태, 서명 비밀을 함께 제거한다', async () => {
    const c = await fixture();
    await c.insert(1, true);
    expect((await c.state())?.signingSecret).toHaveLength(64);
    await c.dataSource.query(
      c.sqlite
        ? 'DELETE FROM vfs_node WHERE namespace_id = ?'
        : 'DELETE FROM vfs_node WHERE namespace_id = $1',
      [c.id],
    );
    await c.dataSource.query(
      c.sqlite ? 'DELETE FROM namespace WHERE id = ?' : 'DELETE FROM namespace WHERE id = $1',
      [c.id],
    );
    expect(await c.state()).toBeNull();
    expect(await c.events()).toEqual([]);
  });
}
