// 소비자 기대: 서버가 재시작된 뒤 같은 멱등성 키로 다시 보낸 요청도 최초 결과를 돌려받고 다시 적용되지 않는다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성, 재시작 후 재시도).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { revision: string };
}

export default defineContract({
  id: 'mutation-replay-restart',
  title: '서버 재시작 뒤 같은 키로 재전송한 성공·충돌 결과가 최초 결과로 재생되고 다시 적용되지 않는다',
  rq: ['RQ-011'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const bytes = Buffer.from('재시작 전 저장', 'utf-8');

    // 재시작 전에 성공(201), 충돌(412), 삭제(200) 세 결과를 각자의 키로 확정한다.
    const createKey = randomUUID();
    const created = await ctx.client.putConditionalContent(
      ns,
      '/a.txt',
      bytes,
      { ifAbsent: true },
      {
        idempotencyKey: createKey,
      },
    );
    assert.equal(created.status, 201);
    const v1 = created.json<ConditionalResult>().resource;

    const conflictKey = randomUUID();
    const conflicting = await ctx.client.putConditionalContent(
      ns,
      '/a.txt',
      Buffer.from('충돌할 본문', 'utf-8'),
      { ifAbsent: true },
      { idempotencyKey: conflictKey },
    );
    assert.equal(conflicting.status, 412);

    const deleteKey = randomUUID();
    const deleteBody = { kind: 'delete', path: '/a.txt', ifRevision: v1.revision };
    const deleted = await ctx.client.postMutation(ns, deleteBody, { idempotencyKey: deleteKey });
    assert.equal(deleted.status, 200);

    await ctx.server.restart();

    // 지금 경로는 비어 있어 다시 평가하면 결과가 달라진다(생성·충돌 요청은 새 파일을 만들며 201, 삭제는 404).
    // 재생이라면 세 요청 모두 최초 status·본문·X-Request-Id 그대로다.
    const createReplay = await ctx.client.putConditionalContent(
      ns,
      '/a.txt',
      bytes,
      { ifAbsent: true },
      {
        idempotencyKey: createKey,
      },
    );
    assert.equal(createReplay.status, 201);
    assert.deepEqual(createReplay.json(), created.json());
    assert.equal(createReplay.headers.get('x-request-id'), created.headers.get('x-request-id'));

    const conflictReplay = await ctx.client.putConditionalContent(
      ns,
      '/a.txt',
      Buffer.from('충돌할 본문', 'utf-8'),
      { ifAbsent: true },
      { idempotencyKey: conflictKey },
    );
    assert.equal(conflictReplay.status, 412);
    assert.deepEqual(conflictReplay.json(), conflicting.json());
    assert.equal(conflictReplay.headers.get('x-request-id'), conflicting.headers.get('x-request-id'));

    const deleteReplay = await ctx.client.postMutation(ns, deleteBody, { idempotencyKey: deleteKey });
    assert.equal(deleteReplay.status, 200);
    assert.deepEqual(deleteReplay.json(), deleted.json());
    assert.equal(deleteReplay.headers.get('x-request-id'), deleted.headers.get('x-request-id'));

    // 재전송이 파일을 다시 만들거나 지우지 않았다.
    assert.equal((await ctx.client.getStat(ns, '/a.txt')).status, 404);
  },
});
