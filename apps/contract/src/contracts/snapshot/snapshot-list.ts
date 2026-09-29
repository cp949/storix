// 소비자 기대: 파일의 snapshot을 페이지 단위로 누락·중복 없이 나열할 수 있고, 파일을 옮기거나 같은 경로에 새로 만들어도 소속이 섞이지 않는다.
// 대응 요구사항: RQ-013(파일별 스냅샷 목록).
import assert from 'node:assert/strict';
import { defineContract, type ContractContext } from '../../define-contract.ts';

const SNAPSHOT_COUNT = 5;
const PAGE_SIZE = 2;

interface ConditionalResult {
  resource: { id: string; revision: string };
}

interface SnapshotPage {
  items: Array<{ snapshotId: string; sourceRevision: string }>;
  nextCursor: string | null;
}

/** 파일 ID의 snapshot을 끝까지 페이지 단위로 읽어 ID 목록과 페이지 수를 돌려준다. */
async function listAll(ctx: ContractContext, namespaceId: string, rootNodeId: string) {
  const ids: string[] = [];
  let pages = 0;
  let cursor: string | undefined;
  do {
    const response = await ctx.client.listSnapshots(namespaceId, rootNodeId, { cursor, limit: PAGE_SIZE });
    assert.equal(response.status, 200);
    const page = response.json<SnapshotPage>();
    assert.ok(page.items.length <= PAGE_SIZE, '페이지가 limit을 넘었다');
    ids.push(...page.items.map((item) => item.snapshotId));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages <= SNAPSHOT_COUNT + 1, '페이지 순회가 끝나지 않는다');
  } while (cursor !== undefined);
  return { ids, pages };
}

export default defineContract({
  id: 'snapshot-list',
  title: '파일별 snapshot을 누락·중복 없이 페이지로 조회하고 이동·재생성 뒤에도 소속이 유지된다',
  rq: ['RQ-013'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    // revision이 서로 다른 snapshot을 여러 건 만든다.
    const created = await ctx.client.putConditionalContent(ns, '/a.txt', Buffer.from('v0', 'utf-8'), {
      ifAbsent: true,
    });
    const file = created.json<ConditionalResult>().resource;
    let revision = file.revision;
    const madeIds: string[] = [];
    for (let index = 0; index < SNAPSHOT_COUNT; index += 1) {
      const snapshot = await ctx.client.createSnapshot(ns, {
        kind: 'file',
        path: '/a.txt',
        sourceRevision: revision,
      });
      assert.equal(snapshot.status, 201);
      madeIds.push(snapshot.json<{ snapshotId: string }>().snapshotId);
      const next = await ctx.client.putConditionalContent(
        ns,
        '/a.txt',
        Buffer.from(`v${index + 1}`, 'utf-8'),
        {
          ifRevision: revision,
        },
      );
      revision = next.json<ConditionalResult>().resource.revision;
    }

    // 작은 limit으로 끝까지 순회해도 만든 snapshot이 정확히 한 번씩 나온다.
    const before = await listAll(ctx, ns, file.id);
    assert.ok(before.pages > 1, '여러 페이지로 나뉘어야 한다');
    assert.equal(new Set(before.ids).size, before.ids.length, '중복이 있다');
    assert.deepEqual([...before.ids].sort(), [...madeIds].sort());

    // 파일을 옮겨도 목록의 소속은 파일 ID를 따라간다.
    const moved = await ctx.client.postMutation(ns, {
      kind: 'move',
      source: '/a.txt',
      destination: '/b.txt',
      sourceRevision: revision,
      destinationAbsent: true,
      destinationResolution: 'exact',
    });
    assert.equal(moved.status, 200);
    assert.deepEqual([...(await listAll(ctx, ns, file.id)).ids].sort(), [...madeIds].sort());

    // 원본을 지우고 같은 경로에 새 파일을 만들면 새 파일의 목록은 비어 있고 옛 목록과 섞이지 않는다.
    const movedStat = (await ctx.client.getStat(ns, '/b.txt')).json<{ revision: string }>();
    const removed = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/b.txt',
      ifRevision: movedStat.revision,
    });
    assert.equal(removed.status, 200);
    const recreated = await ctx.client.putConditionalContent(ns, '/b.txt', Buffer.from('새 파일', 'utf-8'), {
      ifAbsent: true,
    });
    const fresh = recreated.json<ConditionalResult>().resource;
    assert.notEqual(fresh.id, file.id);
    assert.deepEqual((await listAll(ctx, ns, fresh.id)).ids, []);
    assert.deepEqual([...(await listAll(ctx, ns, file.id)).ids].sort(), [...madeIds].sort());

    // 새 파일의 snapshot은 새 파일의 목록에만 나타난다.
    const freshSnapshot = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/b.txt' });
    const freshId = freshSnapshot.json<{ snapshotId: string }>().snapshotId;
    assert.deepEqual((await listAll(ctx, ns, fresh.id)).ids, [freshId]);
    assert.ok(!(await listAll(ctx, ns, file.id)).ids.includes(freshId));
  },
});
