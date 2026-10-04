// 소비자 기대: X-Request-Id는 200자까지 업로드 세션 생성·완료에서 그대로 쓰이고, 201자 이상은 서버가 만든 ID로 대체되며 어느 경우에도 5xx가 아니다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'upload-session-request-id-length',
  title:
    '200자 X-Request-Id로 업로드 세션을 만들고 완료하면 같은 ID가 돌아오고, 201자 이상은 서버가 만든 ID로 대체되며 5xx가 나지 않는다',
  rq: ['RQ-009', 'RQ-018', 'RQ-019'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const base = `/api/v2/namespaces/${ns}/fs/upload-sessions`;
    const create = (path: string, requestId: string) =>
      ctx.client.request('POST', base, {
        headers: {
          'Idempotency-Key': randomUUID(),
          'X-Mutation-Scope': 'request-id-length',
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
        },
        body: JSON.stringify({ path, sizeBytes: '0', mimeType: 'application/octet-stream', ifAbsent: true }),
      });

    // 상한 200자: 생성과 완료가 각자의 요청 ID를 그대로 돌려준다.
    const creationId = 'c'.repeat(200);
    const completionId = 'f'.repeat(200);
    const created = await create('/at-limit.bin', creationId);
    assert.equal(created.status, 201, created.text());
    assert.equal(created.headers.get('x-request-id'), creationId);
    const sessionId = created.json<{ sessionId: string }>().sessionId;
    const completed = await ctx.client.request('POST', `${base}/${sessionId}/complete`, {
      headers: { 'X-Request-Id': completionId },
    });
    assert.equal(completed.status, 201, completed.text());
    assert.equal(completed.headers.get('x-request-id'), completionId);
    assert.equal((await ctx.client.getStat(ns, '/at-limit.bin')).status, 200);

    // 상한+1: 요청 ID가 서버가 만든 값으로 바뀌고 요청은 성공한다.
    const tooLong = 'x'.repeat(201);
    const replaced = await create('/over-limit.bin', tooLong);
    assert.equal(replaced.status, 201, replaced.text());
    const assigned = replaced.headers.get('x-request-id');
    assert.ok(assigned && assigned !== tooLong && assigned.length <= 200, `대체된 요청 ID: ${assigned}`);
  },
});
