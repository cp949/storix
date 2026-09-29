// 소비자 기대: 형식이 잘못됐거나 다른 namespace에서 받은 feed cursor는 400 VFS_INVALID_CURSOR로 거부되어 소비자가 checkpoint부터 다시 시작할 수 있다.
// 대응 요구사항: RQ-029(namespace 변경 feed). 보존 기간이 지난 cursor의 410은 시간 제어가 필요해 다루지 않는다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'change-feed-cursor-errors',
  title:
    '잘못된 cursor와 다른 namespace의 cursor는 400 VFS_INVALID_CURSOR로 거부되고 자기 cursor는 계속 쓸 수 있다',
  rq: ['RQ-029'],
  profile: 'change-feed',
  async run(ctx) {
    const first = await ctx.createNamespace();
    const second = await ctx.createNamespace();
    const checkpoint = await ctx.client.listChanges(first.id);
    assert.equal(checkpoint.status, 200);
    const cursor = checkpoint.json<{ nextCursor: string }>().nextCursor;

    // 형식이 잘못된 cursor와 바꿔치기한 cursor를 거부한다.
    const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const bad of ['garbage', tampered]) {
      const response = await ctx.client.listChanges(first.id, { cursor: bad });
      assert.equal(response.status, 400, bad);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_CURSOR', bad);
    }

    // 다른 namespace에서 받은 cursor는 쓸 수 없다.
    const foreign = await ctx.client.listChanges(second.id, { cursor });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.json<{ code: string }>().code, 'VFS_INVALID_CURSOR');

    // 거부된 뒤에도 원래 namespace에서는 같은 cursor로 계속 읽을 수 있다.
    const created = await ctx.client.putConditionalContent(first.id, '/a.txt', Buffer.from('a'), {
      ifAbsent: true,
    });
    assert.equal(created.status, 201);
    const resumed = await ctx.client.listChanges(first.id, { cursor });
    assert.equal(resumed.status, 200);
    const paths = resumed.json<{ changes: Array<{ path: string }> }>().changes.map((event) => event.path);
    assert.ok(paths.includes('/a.txt'), paths.join(','));
  },
});
