// 소비자 기대: 최대 길이 prefix namespace ID로 feed checkpoint와 후속 cursor를 읽을 수 있다.
// 대응 요구사항: RQ-031(namespace ID 형식).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-id-prefix-cursor',
  title: '최대 길이 prefix namespace ID에서 변경 feed cursor를 읽을 수 있다',
  rq: ['RQ-031'],
  profile: 'change-feed-prefix',
  async run(ctx) {
    const namespaceId = (await ctx.createNamespace()).id;
    assert.equal(namespaceId.length, 45);

    const checkpoint = await ctx.client.listChanges(namespaceId);
    assert.equal(checkpoint.status, 200, checkpoint.text());
    const cursor = checkpoint.json<{ nextCursor: string; changes: unknown[] }>().nextCursor;
    assert.deepEqual(checkpoint.json<{ changes: unknown[] }>().changes, []);

    assert.equal((await ctx.client.mkdir(namespaceId, '/cursor')).status, 201);
    const page = await ctx.client.listChanges(namespaceId, { cursor });
    assert.equal(page.status, 200, page.text());
    assert.ok(page.json<{ changes: unknown[] }>().changes.length > 0);
  },
});
