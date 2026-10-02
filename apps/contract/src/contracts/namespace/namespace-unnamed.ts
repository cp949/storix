// 소비자 기대: 이름이 없는 namespace를 여러 개 만들 수 있고 응답·목록에서 null로 구분한다.
// 대응 요구사항: RQ-002(namespace 격리).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-unnamed',
  title: 'name을 생략한 namespace를 여러 개 만들고 null 이름으로 조회할 수 있다',
  rq: ['RQ-002'],
  async run(ctx) {
    const key = randomUUID();
    const body = JSON.stringify({});
    const first = await ctx.client.request('POST', '/api/v2/namespaces', {
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(first.status, 201, first.text());
    const firstBody = first.json<{ id: string; name: string | null }>();
    assert.equal(firstBody.name, null);

    const replay = await ctx.client.request('POST', '/api/v2/namespaces', {
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(replay.status, 201, replay.text());
    assert.deepEqual(replay.json(), firstBody);

    const second = await ctx.client.request('POST', '/api/v2/namespaces', {
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null }),
    });
    assert.equal(second.status, 201, second.text());
    const secondBody = second.json<{ id: string; name: string | null }>();
    assert.equal(secondBody.name, null);
    assert.notEqual(secondBody.id, firstBody.id);

    const firstRead = await ctx.client.getNamespace(firstBody.id);
    assert.equal(firstRead.status, 200, firstRead.text());
    assert.equal(firstRead.json<{ name: string | null }>().name, null);
    const list = await ctx.client.request('GET', '/api/v2/namespaces?limit=1000');
    assert.equal(list.status, 200, list.text());
    const page = list.json<{ items: Array<{ id: string; name: string | null }> }>();
    const unnamed = page.items.filter((item) => item.name === null).map((item) => item.id);
    assert.ok(unnamed.includes(firstBody.id));
    assert.ok(unnamed.includes(secondBody.id));
    assert.deepEqual(unnamed, [...unnamed].sort());
  },
});
