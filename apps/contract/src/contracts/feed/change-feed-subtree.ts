// 소비자 기대: subtree의 복사·이동·재귀 삭제는 영향받은 노드마다 이벤트가 남고, snapshot 생성·조회·삭제는 이벤트를 만들지 않으며, snapshot 복원으로 파일이 바뀌면 updated가 남는다.
// 대응 요구사항: RQ-029(namespace 변경 feed). 부모·루트 디렉터리의 `updated` 이벤트도 함께 기록되므로 관심 경로의 이벤트만 골라 단언한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface FeedEvent {
  kind: 'created' | 'updated' | 'moved' | 'deleted';
  nodeId: string;
  path: string;
  previousPath?: string;
}

const TREE = ['', '/a.txt', '/sub', '/sub/b.txt'];

export default defineContract({
  id: 'change-feed-subtree',
  title:
    'subtree 복사·이동·삭제는 노드마다 이벤트를 남기고 snapshot 생성·삭제는 남기지 않으며 복원은 updated를 남긴다',
  rq: ['RQ-029'],
  profile: 'change-feed',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const statOf = async (path: string) => {
      const response = await ctx.client.getStat(ns, path);
      assert.equal(response.status, 200, path);
      return response.json<{ id: string; revision: string }>();
    };
    /** 지금 시점을 checkpoint로 잡고, 다음 호출에서 그 뒤의 이벤트만 읽는 함수를 돌려준다. */
    const checkpoint = async () => {
      const response = await ctx.client.listChanges(ns);
      assert.equal(response.status, 200);
      const cursor = response.json<{ nextCursor: string }>().nextCursor;
      return async (): Promise<FeedEvent[]> => {
        const page = await ctx.client.listChanges(ns, { cursor, limit: 1000 });
        assert.equal(page.status, 200);
        return page.json<{ changes: FeedEvent[] }>().changes;
      };
    };
    const forPaths = (events: FeedEvent[], kind: FeedEvent['kind'], paths: string[]) =>
      paths.map((path) => events.filter((event) => event.kind === kind && event.path === path));

    assert.equal((await ctx.client.mkdir(ns, '/src')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/src/sub')).status, 201);
    for (const path of ['/src/a.txt', '/src/sub/b.txt']) {
      const response = await ctx.client.putConditionalContent(ns, path, Buffer.from(path), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, path);
    }

    // 복사: 새로 생긴 노드마다 created가 정확히 하나씩 남는다.
    let readChanges = await checkpoint();
    const copied = await ctx.client.postMutation(ns, {
      kind: 'copy',
      source: '/src',
      destination: '/dup',
      sourceRevision: (await statOf('/src')).revision,
      destinationAbsent: true,
      destinationResolution: 'exact',
    });
    assert.equal(copied.status, 201);
    const copyEvents = await readChanges();
    for (const matches of forPaths(
      copyEvents,
      'created',
      TREE.map((relative) => `/dup${relative}`),
    )) {
      assert.equal(matches.length, 1, JSON.stringify(matches));
    }

    // 이동: 노드마다 moved가 남고 이전 경로가 원래 위치다.
    const idsBeforeMove = await Promise.all(
      TREE.map(async (relative) => (await statOf(`/dup${relative}`)).id),
    );
    readChanges = await checkpoint();
    const moved = await ctx.client.postMutation(ns, {
      kind: 'move',
      source: '/dup',
      destination: '/moved',
      sourceRevision: (await statOf('/dup')).revision,
      destinationAbsent: true,
      destinationResolution: 'exact',
    });
    assert.equal(moved.status, 200);
    const moveEvents = await readChanges();
    TREE.forEach((relative, index) => {
      const matches = moveEvents.filter(
        (event) => event.kind === 'moved' && event.nodeId === idsBeforeMove[index],
      );
      assert.equal(matches.length, 1, `/moved${relative}`);
      assert.equal(matches[0]!.path, `/moved${relative}`);
      assert.equal(matches[0]!.previousPath, `/dup${relative}`);
    });

    // 재귀 삭제: 노드마다 deleted가 남고 경로는 삭제 직전 경로다.
    readChanges = await checkpoint();
    const removed = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/moved',
      ifRevision: (await statOf('/moved')).revision,
      recursive: true,
    });
    assert.equal(removed.status, 200);
    const deleteEvents = await readChanges();
    TREE.forEach((relative, index) => {
      const matches = deleteEvents.filter(
        (event) => event.kind === 'deleted' && event.nodeId === idsBeforeMove[index],
      );
      assert.equal(matches.length, 1, `/moved${relative}`);
      assert.equal(matches[0]!.path, `/moved${relative}`);
    });

    // snapshot 생성·조회·목록·삭제는 이벤트를 만들지 않는다.
    const fileBefore = await statOf('/src/a.txt');
    readChanges = await checkpoint();
    const snapshot = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/src/a.txt' });
    assert.equal(snapshot.status, 201);
    const snapshotId = snapshot.json<{ snapshotId: string }>().snapshotId;
    assert.equal((await ctx.client.getSnapshot(ns, snapshotId)).status, 200);
    assert.equal((await ctx.client.listSnapshots(ns, fileBefore.id)).status, 200);
    assert.deepEqual(await readChanges(), []);

    // 복원으로 파일이 바뀌면 updated가 남는다(먼저 내용을 바꿔 복원이 실제 변경이 되게 한다).
    const replaced = await ctx.client.putConditionalContent(ns, '/src/a.txt', Buffer.from('바뀐 내용'), {
      ifRevision: fileBefore.revision,
    });
    assert.equal(replaced.status, 200);
    readChanges = await checkpoint();
    const restored = await ctx.client.restoreSnapshot(ns, snapshotId, {
      path: '/src/a.txt',
      ifRevision: (await statOf('/src/a.txt')).revision,
    });
    assert.equal(restored.status, 200);
    const restoreEvents = await readChanges();
    assert.ok(
      restoreEvents.some(
        (event) => event.kind === 'updated' && event.nodeId === fileBefore.id && event.path === '/src/a.txt',
      ),
      JSON.stringify(restoreEvents),
    );

    // snapshot 삭제도 이벤트를 만들지 않는다.
    readChanges = await checkpoint();
    assert.equal((await ctx.client.deleteSnapshot(ns, snapshotId)).status, 200);
    assert.deepEqual(await readChanges(), []);
  },
});
