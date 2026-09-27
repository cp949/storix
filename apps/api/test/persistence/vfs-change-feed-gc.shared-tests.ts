import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { VfsChangeFeedRetentionRepository } from '../../src/persistence/vfs-change-feed-retention.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsChangeCursorExpiredError } from '../../src/vfs/vfs.errors.js';

interface Context {
  readonly dataSource: DataSource;
  readonly nodes: VfsNodeRepository;
  readonly retention: VfsChangeFeedRetentionRepository;
  readonly sqlite: boolean;
}

export function runVfsChangeFeedGcSharedTests(get: () => Context): void {
  async function fixture() {
    const c = get();
    const namespace = await new NamespaceProvisioningRepository(c.dataSource)
      .createWithRoot(`feed-gc-${randomUUID()}`);
    const root = await c.nodes.getRoot(namespace.id);
    if (!root) throw new Error('root missing');
    await c.nodes.createChangeFeedCheckpoint(namespace.id, root.id);
    const insert = async (sequence: number, old: boolean) => {
      const args = c.sqlite ? '(?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ' :
        '($1, $2, $3, 0, 1, $4, $5, $6, $7, $8, ';
      const time = c.sqlite ? (old ? "datetime('now', '-31 days')" : "datetime('now')") :
        (old ? "CURRENT_TIMESTAMP - INTERVAL '31 days'" : 'CURRENT_TIMESTAMP');
      await c.dataSource.query(`INSERT INTO vfs_change_event
        (namespace_id, sequence, operation_id, operation_index, operation_count,
         kind, node_id, node_type, path, revision, occurred_at)
        VALUES ${args}${time})`, [namespace.id, String(sequence), randomUUID(), 'created',
        randomUUID(), 'DIRECTORY', `/event-${sequence}`, `r${sequence}`]);
      await c.dataSource.query(c.sqlite ?
        'UPDATE vfs_change_feed_state SET last_sequence = ? WHERE namespace_id = ?' :
        'UPDATE vfs_change_feed_state SET last_sequence = $1 WHERE namespace_id = $2',
      [String(sequence), namespace.id]);
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
    expect(await c.retention.pruneExpiredBatch(30, 1)).toBe(1);
    expect((await c.state())?.prunedThrough).toBe('1');
    expect(await c.retention.pruneExpiredBatch(30, 1)).toBe(1);
    expect((await c.state())?.prunedThrough).toBe('2');
    expect(await c.retention.pruneExpiredBatch(30, 2)).toBe(0);
    expect((await c.events()).map((event) => event.sequence)).toEqual(['3', '4']);
    const page = await c.nodes.readChangeFeedPage(c.id, 10, (state) => {
      expect(state?.prunedThrough).toBe('2');
      return '2';
    });
    expect(page.events.map((event) => event.sequence)).toEqual(['3', '4']);
    await c.dataSource.query(c.sqlite ?
      "UPDATE vfs_change_event SET occurred_at = datetime('now', '-31 days') WHERE namespace_id = ? AND sequence = 3" :
      "UPDATE vfs_change_event SET occurred_at = CURRENT_TIMESTAMP - INTERVAL '31 days' WHERE namespace_id = $1 AND sequence = 3",
    [c.id]);
    expect(await c.retention.pruneExpiredBatch(30, 2)).toBe(2);
    expect(await c.retention.pruneExpiredBatch(30, 2)).toBe(0);
    expect((await c.state())?.prunedThrough).toBe('4');
    expect((await c.state())?.lastSequence).toBe('4');
    expect(await c.events()).toEqual([]);
  });

  it('시퀀스 1~12를 숫자 순서로 한 건씩 정리해 경계가 12까지 전진한다', async () => {
    const c = await fixture();
    for (let sequence = 1; sequence <= 12; sequence++) await c.insert(sequence, true);
    for (let sequence = 1; sequence <= 12; sequence++) {
      expect(await c.retention.pruneExpiredBatch(30, 1)).toBe(1);
      expect((await c.state())?.prunedThrough).toBe(String(sequence));
    }
    expect(await c.retention.pruneExpiredBatch(30, 1)).toBe(0);
    expect((await c.state())?.lastSequence).toBe('12');
    expect(await c.events()).toEqual([]);
  });

  it('페이지 state 조회와 GC 사이의 경합은 일관된 페이지 또는 만료 경계로 끝난다', async () => {
    const c = await fixture();
    await c.insert(1, true);
    await c.insert(2, true);
    let entered!: () => void;
    let release!: () => void;
    const stateRead = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const pagePromise = c.nodes.readChangeFeedPage(c.id, 3, async () => {
      entered();
      await resume;
      return '0';
    });
    await stateRead;
    const gcPromise = c.retention.pruneExpiredBatch(30, 2);
    if (!c.sqlite) expect(await gcPromise).toBe(2);
    release();
    const page = await pagePromise;
    expect(page.events.map((event) => event.sequence)).toEqual(['1', '2']);
    if (c.sqlite) expect(await gcPromise).toBe(2);
    expect((await c.state())?.prunedThrough).toBe('2');
    await expect(c.nodes.readChangeFeedPage(c.id, 3, (state) => {
      if (0n < BigInt(state!.prunedThrough)) throw new VfsChangeCursorExpiredError();
      return '0';
    })).rejects.toBeInstanceOf(VfsChangeCursorExpiredError);
    expect((await c.nodes.readChangeFeedPage(c.id, 3, (state) => {
      expect(state?.prunedThrough).toBe('2');
      return '2';
    })).events).toEqual([]);
  });

  it('namespace 삭제는 이벤트, 상태, 서명 비밀을 함께 제거한다', async () => {
    const c = await fixture();
    await c.insert(1, true);
    expect((await c.state())?.signingSecret).toHaveLength(64);
    await c.dataSource.query(c.sqlite ? 'DELETE FROM vfs_node WHERE namespace_id = ?' :
      'DELETE FROM vfs_node WHERE namespace_id = $1', [c.id]);
    await c.dataSource.query(c.sqlite ? 'DELETE FROM namespace WHERE id = ?' :
      'DELETE FROM namespace WHERE id = $1', [c.id]);
    expect(await c.state()).toBeNull();
    expect(await c.events()).toEqual([]);
  });
}
