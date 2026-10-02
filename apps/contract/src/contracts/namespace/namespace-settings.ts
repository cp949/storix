// 소비자 기대: 관리자만 namespace 설정을 부분 변경하고, 유효한 요청은 멱등하게 재생된다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-settings',
  title: '관리자는 namespace 설정을 부분 변경하고 동일 요청을 재생한다',
  rq: ['RQ-034'],
  async run(ctx) {
    const namespaceId = (await ctx.createNamespace()).id;
    const path = `/api/v2/admin/namespaces/${namespaceId}/settings`;
    const send = (key: string, body: unknown, adminKey = ctx.adminKey) =>
      ctx.client.request('PATCH', path, {
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      });

    const unauthorized = await send(randomUUID(), { trashEnabled: true }, ctx.apiKey);
    assert.equal(unauthorized.status, 401, unauthorized.text());
    const noKey = await ctx.client.request('PATCH', path, {
      headers: { Authorization: `Bearer ${ctx.adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashEnabled: true }),
    });
    assert.equal(noKey.status, 400, noKey.text());
    assert.equal(noKey.json<{ code: string }>().code, 'IDEMPOTENCY_KEY_REQUIRED');

    const key = randomUUID();
    const body = { maxNodes: '17', excludeTrashFromQuota: true };
    const updated = await send(key, body);
    assert.equal(updated.status, 200, updated.text());
    const response = updated.json<{
      limits: { maxNodes: string };
      quota: { excludeTrash: boolean };
    }>();
    assert.equal(response.limits.maxNodes, '17');
    assert.equal(response.quota.excludeTrash, true);
    const replay = await send(key, body);
    assert.equal(replay.status, 200, replay.text());
    assert.deepEqual(replay.json(), updated.json());

    const reused = await send(key, { maxNodes: '18' });
    assert.equal(reused.status, 422, reused.text());
    assert.equal(reused.json<{ code: string }>().code, 'IDEMPOTENCY_KEY_REUSED');
    for (const invalid of [{}, { unsupported: true }, { trashEnabled: null }]) {
      const rejected = await send(randomUUID(), invalid);
      assert.equal(rejected.status, 400, rejected.text());
      assert.equal(rejected.json<{ code: string }>().code, 'NAMESPACE_INVALID_SETTINGS_REQUEST');
    }
    const cleared = await send(randomUUID(), { maxNodes: null });
    assert.equal(cleared.status, 200, cleared.text());
    assert.notEqual(cleared.json<{ limits: { maxNodes: string } }>().limits.maxNodes, '17');
  },
});
