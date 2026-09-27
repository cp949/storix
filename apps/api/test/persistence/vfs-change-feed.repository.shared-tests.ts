import { DataSource } from 'typeorm';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { encodeRevision } from '../../src/vfs/revision.js';

interface Context {
  readonly dataSource: DataSource;
  readonly repository: VfsNodeRepository;
}

export function runVfsChangeFeedRepositorySharedTests(getContext: () => Context): void {
  let counter = 0;
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function setup() {
    const { dataSource, repository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource)
      .createWithRoot(`feed-${++counter}`);
    const root = await repository.getRoot(namespace.id);
    if (!root) throw new Error('namespace root missing');
    const events = () => repository.listChangeFeedEvents(namespace.id, '0', 1001);
    const state = async () => {
      const found = await repository.getChangeFeedState(namespace.id);
      if (!found) throw new Error('change feed state missing');
      return found;
    };
    const blob = () => ({
      storageKey: `feed/${counter}/${Math.random()}`,
      size: '0',
      mimeType: 'application/octet-stream',
      sha256: '0'.repeat(64),
      encryptionIv: null,
    });
    return { dataSource, repository, namespaceId: namespace.id, rootId: root.id, events, state, blob };
  }

  it('첫 checkpoint 전에는 기록하지 않고 이후 create/update와 조상 revision을 순서대로 기록한다', async () => {
    const c = await setup();
    await c.repository.ensureDirectory(c.namespaceId, c.rootId, ['a'], false);
    expect(await c.events()).toEqual([]);
    expect(await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId)).toBe('0');
    const secret = (await c.state()).signingSecret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId)).toBe('0');
    expect((await c.state()).signingSecret).toBe(secret);
    await c.repository.touchFile(c.namespaceId, c.rootId, ['a', 'f'], false, c.blob());
    const first = await c.events();
    expect(first.map((event) => [event.sequence, event.kind, event.path])).toEqual([
      ['1', 'updated', '/'], ['2', 'updated', '/a'], ['3', 'created', '/a/f'],
    ]);
    expect(first.map((event) => event.operationIndex)).toEqual([0, 1, 2]);
    expect(new Set(first.map((event) => event.operationId)).size).toBe(1);
    expect(first.every((event) => event.operationCount === 3 && event.revision !== null)).toBe(true);
    expect(first.every((event) => event.occurredAt instanceof Date)).toBe(true);
    await c.repository.putFileContent(c.namespaceId, c.rootId, ['a', 'f'], false, c.blob(), null, true);
    expect((await c.events()).at(-1)).toMatchObject({ sequence: '6', kind: 'updated', path: '/a/f' });
    expect((await c.state()).lastSequence).toBe('6');
  });

  it('rollback은 sequence를 보존하고 일시 생성·삭제는 커밋된 조상 revision만 기록한다', async () => {
    const c = await setup();
    await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId);
    await expect(c.repository.withMutation(c.namespaceId, c.rootId, async (tx) => {
      await c.repository.touchFile(c.namespaceId, c.rootId, ['rolled'], false, c.blob(), tx);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await c.events()).toEqual([]);
    expect((await c.state()).lastSequence).toBe('0');
    const rootBefore = await c.repository.getRoot(c.namespaceId);
    if (!rootBefore) throw new Error('namespace root missing');
    const mutation = await c.repository.withMutation(c.namespaceId, c.rootId, async (tx) => {
      await c.repository.touchFile(c.namespaceId, c.rootId, ['transient'], false, c.blob(), tx);
      await c.repository.removeNode(c.namespaceId, c.rootId, ['transient'], false, 10, tx);
    });
    const rootAfter = await c.repository.getRoot(c.namespaceId);
    if (!rootAfter) throw new Error('namespace root missing');
    expect(rootAfter.version).toBe(rootBefore.version + 1);
    expect(await c.repository.resolvePath(c.namespaceId, c.rootId, ['transient'])).toBeNull();
    const revision = encodeRevision(rootAfter);
    expect(mutation.affectedRevisions).toEqual([{ path: '/', revision }]);
    const events = await c.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      namespaceId: c.namespaceId, sequence: '1', kind: 'updated', nodeId: c.rootId,
      nodeType: 'DIRECTORY', path: '/', previousPath: null, revision,
      operationIndex: 0, operationCount: 1,
    });
    expect((await c.state()).lastSequence).toBe('1');
  });

  it('첫 checkpoint와 namespace mutation은 직렬화되어 전체 열거 경계에 공백이 없다', async () => {
    const c = await setup();
    const entered = deferred();
    const release = deferred();
    const mutation = c.repository.withMutation(c.namespaceId, c.rootId, async (tx) => {
      await c.repository.touchFile(c.namespaceId, c.rootId, ['checkpoint-race'], false, c.blob(), tx);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    let checkpointFinished = false;
    const checkpoint = c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId)
      .then((sequence) => { checkpointFinished = true; return sequence; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checkpointFinished).toBe(false);

    release.resolve();
    await mutation;
    expect(await checkpoint).toBe('0');
    expect(await c.repository.resolvePath(c.namespaceId, c.rootId, ['checkpoint-race']))
      .not.toBeNull();
    expect(await c.events()).toEqual([]);
  });

  it('같은 namespace 경쟁 mutation은 한 트랜잭션씩 실행하고 commit 순서로 sequence를 준다', async () => {
    const c = await setup();
    await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const first = c.repository.withMutation(c.namespaceId, c.rootId, async (tx) => {
      await c.repository.touchFile(c.namespaceId, c.rootId, ['first'], false, c.blob(), tx);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = c.repository.withMutation(c.namespaceId, c.rootId, async (tx) => {
      secondEntered.resolve();
      await c.repository.touchFile(c.namespaceId, c.rootId, ['second'], false, c.blob(), tx);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let secondStarted = false;
    void secondEntered.promise.then(() => { secondStarted = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    const created = (await c.events()).filter((event) => event.kind === 'created');
    expect(created.map(({ path, sequence }) => [path, sequence])).toEqual([
      ['/first', '2'], ['/second', '4'],
    ]);
  });

  it('서로 다른 namespace는 각자 독립된 sequence를 유지한다', async () => {
    const first = await setup();
    const second = await setup();
    await Promise.all([
      first.repository.createChangeFeedCheckpoint(first.namespaceId, first.rootId),
      second.repository.createChangeFeedCheckpoint(second.namespaceId, second.rootId),
    ]);
    await Promise.all([
      first.repository.touchFile(first.namespaceId, first.rootId, ['first'], false, first.blob()),
      second.repository.touchFile(second.namespaceId, second.rootId, ['second'], false, second.blob()),
    ]);
    const [firstEvents, secondEvents] = await Promise.all([first.events(), second.events()]);
    expect(firstEvents.map(({ sequence }) => sequence)).toEqual(['1', '2']);
    expect(secondEvents.map(({ sequence }) => sequence)).toEqual(['1', '2']);
    expect(firstEvents.map(({ path }) => path)).toEqual(['/', '/first']);
    expect(secondEvents.map(({ path }) => path)).toEqual(['/', '/second']);
  });

  it('2^53보다 큰 sequence와 prunedThrough를 손실 없이 checkpoint·event page에 보존한다', async () => {
    const c = await setup();
    await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId);
    const high = '9007199254740993';
    await c.dataSource.getRepository(VfsChangeFeedStateEntity).update(
      { namespaceId: c.namespaceId }, { lastSequence: high, prunedThrough: high },
    );
    expect(await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId)).toBe(high);
    expect((await c.state()).prunedThrough).toBe(high);
    await c.repository.touchFile(c.namespaceId, c.rootId, ['large-sequence'], false, c.blob());
    const page = await c.repository.listChangeFeedEvents(c.namespaceId, high, 100);
    expect(page.map((event) => event.sequence)).toEqual([
      '9007199254740994', '9007199254740995',
    ]);
    expect((await c.state()).lastSequence).toBe('9007199254740995');
    expect((await c.repository.listChangeFeedEvents(c.namespaceId, page[0].sequence, 100))
      .map((event) => event.sequence)).toEqual(['9007199254740995']);
  });

  it('sequence 9→10 경계의 작은 페이지도 숫자 순서로 재개한다', async () => {
    const c = await setup();
    await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId);
    await c.dataSource.getRepository(VfsChangeFeedStateEntity).update(
      { namespaceId: c.namespaceId }, { lastSequence: '8', prunedThrough: '8' },
    );
    await c.repository.touchFile(c.namespaceId, c.rootId, ['numeric-order'], false, c.blob());
    const first = await c.repository.listChangeFeedEvents(c.namespaceId, '8', 1);
    expect(first.map((event) => event.sequence)).toEqual(['9']);
    const second = await c.repository.listChangeFeedEvents(c.namespaceId, first[0].sequence, 1);
    expect(second.map((event) => event.sequence)).toEqual(['10']);
    expect(await c.repository.listChangeFeedEvents(c.namespaceId, second[0].sequence, 1)).toEqual([]);
  });

  it('같은 노드의 반복 변경은 최종 상태 한 항목이며 path segment/nodeId 순서가 일정하다', async () => {
    const c = await setup();
    await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId);
    await c.repository.withMutation(c.namespaceId, c.rootId, async (tx) => {
      await c.repository.touchFile(c.namespaceId, c.rootId, ['a.b'], false, c.blob(), tx);
      await c.repository.touchFile(c.namespaceId, c.rootId, ['a'], false, c.blob(), tx);
      await c.repository.touchFile(c.namespaceId, c.rootId, ['a'], false, c.blob(), tx);
    });
    const rows = await c.events();
    expect(rows.map((event) => [event.kind, event.path])).toEqual([
      ['updated', '/'], ['created', '/a'], ['created', '/a.b'],
    ]);
    expect(rows.filter((event) => event.path === '/a')).toHaveLength(1);
  });

  it('subtree copy/move/delete는 노드별 생성, 이전 경로, tombstone을 기록한다', async () => {
    const c = await setup();
    await c.repository.ensureDirectory(c.namespaceId, c.rootId, ['src'], false);
    await c.repository.touchFile(c.namespaceId, c.rootId, ['src', 'f'], false, c.blob());
    await c.repository.createChangeFeedCheckpoint(c.namespaceId, c.rootId);
    await c.repository.copyNode(c.namespaceId, c.rootId, ['src'], ['copy'], false, 10);
    const copied = await c.events();
    expect(copied.filter((event) => event.kind === 'created').map((event) => event.path))
      .toEqual(['/copy', '/copy/f']);
    await c.repository.moveNode(c.namespaceId, c.rootId, ['src'], ['moved'], false);
    const moved = (await c.events()).filter((event) => event.kind === 'moved');
    expect(moved.map((event) => [event.previousPath, event.path]))
      .toEqual([['/src', '/moved'], ['/src/f', '/moved/f']]);
    await c.repository.removeNode(c.namespaceId, c.rootId, ['moved'], true, 10);
    const deleted = (await c.events()).filter((event) => event.kind === 'deleted');
    expect(deleted.map((event) => [event.path, event.previousPath, event.revision]))
      .toEqual([['/moved', null, null], ['/moved/f', null, null]]);
  });
}
