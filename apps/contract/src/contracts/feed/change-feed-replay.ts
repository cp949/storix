// 소비자 기대: cursor 없이 받은 checkpoint 이후의 변경을 순서대로 재생할 수 있고, 같은 cursor는 같은 결과를 주며, 변경이 없으면 cursor가 유지되고, 서버를 재시작해도 기록이 남는다.
// 대응 요구사항: RQ-029(namespace 변경 feed). 부모·루트 디렉터리의 `updated` 이벤트도 함께 기록되므로 관심 노드의 이벤트만 골라 단언한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';
import type { ApiClient } from '../../define-contract.ts';

interface FeedEvent {
  sequence: string;
  operationId: string;
  operationIndex: number;
  operationCount: number;
  kind: 'created' | 'updated' | 'moved' | 'deleted';
  nodeId: string;
  nodeType: 'FILE' | 'DIRECTORY';
  path: string;
  previousPath?: string;
  revision?: string;
}

interface FeedPage {
  changes: FeedEvent[];
  nextCursor: string;
  hasMore: boolean;
}

async function readPage(
  client: ApiClient,
  ns: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<FeedPage> {
  const response = await client.listChanges(ns, options);
  assert.equal(response.status, 200, response.text());
  return response.json<FeedPage>();
}

/** cursor부터 hasMore가 false가 될 때까지 페이지를 이어 읽는다. */
async function readAll(client: ApiClient, ns: string, cursor: string, limit: number): Promise<FeedEvent[]> {
  const events: FeedEvent[] = [];
  let next = cursor;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await readPage(client, ns, { cursor: next, limit });
    events.push(...page.changes);
    next = page.nextCursor;
    if (!page.hasMore) return events;
  }
  throw new Error('feed가 끝나지 않는다');
}

export default defineContract({
  id: 'change-feed-replay',
  title:
    'checkpoint 이후 변경이 순서대로 재생되고 같은 cursor는 같은 결과이며 빈 페이지는 cursor를 유지하고 재시작 뒤에도 남는다',
  rq: ['RQ-029'],
  profile: 'change-feed',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    // cursor 없이 호출하면 변경 없는 checkpoint를 받는다.
    const checkpoint = await readPage(ctx.client, ns);
    assert.deepEqual(checkpoint.changes, []);
    assert.equal(checkpoint.hasMore, false);
    assert.equal(typeof checkpoint.nextCursor, 'string');
    const start = checkpoint.nextCursor;

    // 디렉터리 생성, 파일 생성·교체·이동·삭제를 차례로 수행한다.
    assert.equal((await ctx.client.mkdir(ns, '/d')).status, 201);
    const created = await ctx.client.putConditionalContent(ns, '/d/a.txt', Buffer.from('a'), {
      ifAbsent: true,
    });
    const file = created.json<{ resource: { id: string; revision: string } }>().resource;
    const replaced = await ctx.client.putConditionalContent(ns, '/d/a.txt', Buffer.from('b'), {
      ifRevision: file.revision,
    });
    assert.equal(replaced.status, 200);
    const moved = await ctx.client.move(ns, { source: '/d/a.txt', destination: '/e.txt' });
    assert.equal(moved.status, 200);
    const finalRevision = (await ctx.client.getStat(ns, '/e.txt')).json<{ revision: string }>().revision;

    // 재생 결과: sequence는 십진 문자열이고 엄격히 증가한다.
    const all = await readAll(ctx.client, ns, start, 1000);
    const sequences = all.map((event) => BigInt(event.sequence));
    for (let index = 1; index < sequences.length; index += 1) {
      assert.ok(sequences[index]! > sequences[index - 1]!, `sequence 증가: ${sequences.join(',')}`);
    }

    // 파일의 이벤트: 생성, 교체, 이동 순서이고 이동은 이전 경로를 알린다.
    const fileEvents = all.filter((event) => event.nodeId === file.id);
    assert.deepEqual(
      fileEvents.map((event) => event.kind),
      ['created', 'updated', 'moved'],
    );
    assert.equal(fileEvents[0]!.path, '/d/a.txt');
    assert.equal(fileEvents[2]!.path, '/e.txt');
    assert.equal(fileEvents[2]!.previousPath, '/d/a.txt');
    for (const event of fileEvents) assert.equal(event.nodeType, 'FILE');
    // 살아 있는 노드의 마지막 이벤트 revision은 현재 revision이다.
    assert.equal(fileEvents[2]!.revision, finalRevision);

    // 삭제는 마지막 경로를 알리고 revision이 없다.
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/e.txt',
      ifRevision: finalRevision,
    });
    assert.equal(deleted.status, 200);
    const afterDelete = await readAll(ctx.client, ns, start, 1000);
    const deleteEvent = afterDelete.filter((event) => event.nodeId === file.id).at(-1)!;
    assert.equal(deleteEvent.kind, 'deleted');
    assert.equal(deleteEvent.path, '/e.txt');
    assert.equal(deleteEvent.revision, undefined);

    // 같은 transaction의 이벤트는 operationId로 묶이고 index가 0부터 count까지 빠짐없이 이어진다.
    const groups = new Map<string, FeedEvent[]>();
    for (const event of afterDelete) {
      groups.set(event.operationId, [...(groups.get(event.operationId) ?? []), event]);
    }
    for (const [operationId, events] of groups) {
      const count = events[0]!.operationCount;
      assert.equal(events.length, count, operationId);
      assert.deepEqual(
        events.map((event) => event.operationIndex).sort((a, b) => a - b),
        Array.from({ length: count }, (_, index) => index),
        operationId,
      );
    }

    // 같은 cursor를 다시 읽으면 같은 결과이고, 작은 limit으로 나눠 읽어도 이어 붙이면 같다.
    assert.deepEqual(await readAll(ctx.client, ns, start, 1000), afterDelete);
    const paged = await readAll(ctx.client, ns, start, 2);
    assert.deepEqual(paged, afterDelete);
    const firstPage = await readPage(ctx.client, ns, { cursor: start, limit: 2 });
    assert.equal(firstPage.changes.length, 2);
    assert.equal(firstPage.hasMore, true);

    // 변경이 없으면 빈 페이지가 입력 cursor를 그대로 돌려준다.
    const lastCursor = (await readPage(ctx.client, ns, { cursor: start, limit: 1000 })).nextCursor;
    const idle = await readPage(ctx.client, ns, { cursor: lastCursor });
    assert.deepEqual(idle.changes, []);
    assert.equal(idle.hasMore, false);
    assert.equal(idle.nextCursor, lastCursor);

    // 재시작 뒤에도 같은 cursor로 같은 기록을 읽을 수 있다.
    await ctx.server.restart();
    assert.deepEqual(await readAll(ctx.client, ns, start, 1000), afterDelete);
  },
});
