// 소비자 기대: namespace 생성의 Idempotency-Key는 255 byte까지 쓸 수 있고, 255 byte를 넘으면 5xx가 아니라 400으로 거절된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-idempotency-key-length',
  title:
    'namespace 생성은 255 byte Idempotency-Key로 성공·재생되고, 256 byte 키는 namespace를 만들지 않고 400 IDEMPOTENCY_KEY_REQUIRED로 거절한다',
  rq: ['RQ-011', 'RQ-018'],
  async run(ctx) {
    const create = (key: string, name: string) =>
      ctx.client.request('POST', '/api/v2/namespaces', {
        headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    const name = `key-length-${randomUUID()}`;

    const key = 'k'.repeat(255);
    const first = await create(key, name);
    assert.equal(first.status, 201, first.text());
    const replay = await create(key, name);
    assert.equal(replay.status, 201, replay.text());
    assert.deepEqual(replay.json(), first.json());

    const rejectedName = `key-length-rejected-${randomUUID()}`;
    const rejected = await create('k'.repeat(256), rejectedName);
    assert.equal(rejected.status, 400, rejected.text());
    assert.equal(rejected.json<{ code: string }>().code, 'IDEMPOTENCY_KEY_REQUIRED');

    // 거절된 요청은 namespace를 만들지 않는다. 같은 name을 다른 키로 만들 수 있다.
    const afterReject = await create(randomUUID(), rejectedName);
    assert.equal(afterReject.status, 201, afterReject.text());
  },
});
