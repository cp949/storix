// 소비자 기대: snapshot 하나를 삭제해도 현재 파일과 나머지 snapshot은 그대로 조회된다.
// 대응 요구사항: RQ-016(스냅샷 삭제와 보존).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'snapshot-delete',
  title: 'snapshot 하나를 삭제해도 현재 파일과 나머지 snapshot은 변하지 않는다',
  rq: ['RQ-016'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const first = Buffer.from('첫 번째 revision', 'utf-8');
    const second = Buffer.from('두 번째 revision', 'utf-8');

    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', first, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;
    const s1 = (await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.txt' })).json<{
      snapshotId: string;
    }>().snapshotId;
    await ctx.client.putConditionalContent(ns, '/doc.txt', second, { ifRevision: v1.revision });
    const s2 = (await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.txt' })).json<{
      snapshotId: string;
    }>().snapshotId;

    const fileBefore = await ctx.client.getContent(ns, '/doc.txt');
    const statBefore = (await ctx.client.getStat(ns, '/doc.txt')).json();
    const s2Before = (await ctx.client.getSnapshot(ns, s2)).json();

    // 첫 snapshot을 삭제한다.
    const deleted = await ctx.client.deleteSnapshot(ns, s1);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json(), { snapshotId: s1, deleted: true });

    // 삭제한 snapshot은 메타데이터·내용 모두 없다.
    assert.equal((await ctx.client.getSnapshot(ns, s1)).status, 404);
    assert.equal((await ctx.client.getSnapshotContent(ns, s1)).status, 404);

    // 현재 파일은 바이트·revision·stat 모두 그대로다.
    const fileAfter = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(fileAfter.bytes, second);
    assert.equal(fileAfter.headers.get('x-storix-revision'), fileBefore.headers.get('x-storix-revision'));
    assert.deepEqual((await ctx.client.getStat(ns, '/doc.txt')).json(), statBefore);

    // 나머지 snapshot은 메타데이터·바이트가 그대로이고 목록에도 남아 있다.
    assert.deepEqual((await ctx.client.getSnapshot(ns, s2)).json(), s2Before);
    assert.deepEqual((await ctx.client.getSnapshotContent(ns, s2)).bytes, second);
    const list = (await ctx.client.listSnapshots(ns, v1.id)).json<{ items: Array<{ snapshotId: string }> }>();
    assert.deepEqual(
      list.items.map((item) => item.snapshotId),
      [s2],
    );
  },
});
