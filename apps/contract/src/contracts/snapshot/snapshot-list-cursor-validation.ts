// 소비자 기대: snapshot 목록의 cursor가 존재하지 않는 날짜나 0000년을 담으면 서버 오류 없이 400 VFS_INVALID_CURSOR로 거부되고, 거부된 뒤에도 정상 cursor로 목록을 이어 읽을 수 있다.
// 대응 요구사항: RQ-013(파일별 스냅샷 목록). 잘못되거나 변조된 cursor는 400 VFS_INVALID_CURSOR다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

interface Page {
  items: Array<{ snapshotId: string }>;
  nextCursor: string | null;
}

export default defineContract({
  id: 'snapshot-list-cursor-validation',
  title:
    '존재하지 않는 날짜나 0000년을 담은 snapshot 목록 cursor는 400 VFS_INVALID_CURSOR로 거부되고 정상 cursor는 계속 쓸 수 있다',
  rq: ['RQ-013'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const created = await ctx.client.putConditionalContent(ns, '/a.txt', Buffer.from('v0'), {
      ifAbsent: true,
    });
    const file = created.json<ConditionalResult>().resource;
    let revision = file.revision;
    for (let index = 0; index < 3; index += 1) {
      const snapshot = await ctx.client.createSnapshot(ns, {
        kind: 'file',
        path: '/a.txt',
        sourceRevision: revision,
      });
      assert.equal(snapshot.status, 201, snapshot.text());
      const next = await ctx.client.putConditionalContent(ns, '/a.txt', Buffer.from(`v${index + 1}`), {
        ifRevision: revision,
      });
      revision = next.json<ConditionalResult>().resource.revision;
    }
    const first = await ctx.client.listSnapshots(ns, file.id, { limit: 1 });
    assert.equal(first.status, 200, first.text());
    const firstPage = first.json<Page>();
    assert.ok(firstPage.nextCursor !== null);

    // cursor는 불투명하지만, 서버가 만든 형식에서 시각만 바꾼 값이 SQL까지 닿지 않고 거부되는지 확인하려면 형식을 흉내 내야 한다.
    for (const createdAtKey of ['2026-02-30T01:02:03.123456Z', '0000-01-01T00:00:00.123456Z']) {
      const cursor = `sl1.${Buffer.from(
        JSON.stringify({ namespaceId: ns, rootNodeId: file.id, createdAtKey, snapshotId: randomUUID() }),
        'utf8',
      ).toString('base64url')}`;
      const response = await ctx.client.listSnapshots(ns, file.id, { cursor });
      assert.equal(response.status, 400, `${createdAtKey}: ${response.text()}`);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_CURSOR', createdAtKey);
    }

    // 거부된 뒤에도 서버가 만든 cursor로 다음 페이지를 읽는다.
    const second = await ctx.client.listSnapshots(ns, file.id, { limit: 1, cursor: firstPage.nextCursor });
    assert.equal(second.status, 200, second.text());
    const secondIds = second.json<Page>().items.map((item) => item.snapshotId);
    assert.equal(secondIds.length, 1);
    assert.notEqual(secondIds[0], firstPage.items[0]?.snapshotId);
  },
});
