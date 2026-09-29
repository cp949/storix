// 소비자 기대: 같은 멱등성 키로 같은 요청을 다시 보내면 변경 없이 최초 결과를 돌려받고, 다른 요청에 같은 키를 쓰면 거부된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'mutation-replay',
  title: '같은 키의 같은 요청은 최초 결과를 재생하고 한 번만 적용하며, 같은 키의 다른 요청은 409로 거부한다',
  rq: ['RQ-011'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const original = Buffer.from('최초 저장', 'utf-8');

    // 조건부 저장: 응답을 못 받았다고 가정하고 같은 키로 다시 보낸다.
    const key = randomUUID();
    const first = await ctx.client.putConditionalContent(
      ns,
      '/a.txt',
      original,
      { ifAbsent: true },
      {
        idempotencyKey: key,
      },
    );
    assert.equal(first.status, 201);
    const v1 = first.json<ConditionalResult>().resource;

    // 그 사이 다른 호출자가 파일을 바꿨다. 재전송이 다시 평가된다면 412가 되거나 상태를 덮어쓴다.
    const other = await ctx.client.putConditionalContent(ns, '/a.txt', Buffer.from('다른 호출자', 'utf-8'), {
      ifRevision: v1.revision,
    });
    assert.equal(other.status, 200);
    const current = other.json<ConditionalResult>().resource;

    const replay = await ctx.client.putConditionalContent(
      ns,
      '/a.txt',
      original,
      { ifAbsent: true },
      {
        idempotencyKey: key,
      },
    );
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.json(), first.json());
    assert.equal(replay.headers.get('x-request-id'), first.headers.get('x-request-id'));
    const afterReplay = await ctx.client.getContent(ns, '/a.txt');
    assert.equal(
      afterReplay.headers.get('x-storix-revision'),
      current.revision,
      '재전송이 변경을 다시 적용했다',
    );
    assert.deepEqual(afterReplay.bytes, Buffer.from('다른 호출자', 'utf-8'));

    // 같은 키로 다른 요청(본문이 다름)을 보내면 재사용 오류이고 파일은 바뀌지 않는다.
    const reused = await ctx.client.putConditionalContent(
      ns,
      '/a.txt',
      Buffer.from('키를 재사용한 다른 본문', 'utf-8'),
      { ifAbsent: true },
      { idempotencyKey: key },
    );
    assert.equal(reused.status, 409);
    assert.equal(reused.json<{ code: string }>().code, 'MUTATION_KEY_REUSED');
    assert.deepEqual((await ctx.client.getContent(ns, '/a.txt')).bytes, Buffer.from('다른 호출자', 'utf-8'));

    // 조건부 변경(delete): 삭제 뒤 같은 경로에 새 파일이 생겨도 재전송은 최초 응답만 돌려주고 새 파일을 지우지 않는다.
    const deleteKey = randomUUID();
    const deleteBody = { kind: 'delete', path: '/a.txt', ifRevision: current.revision };
    const deleted = await ctx.client.postMutation(ns, deleteBody, { idempotencyKey: deleteKey });
    assert.equal(deleted.status, 200);
    const recreated = await ctx.client.putConditionalContent(ns, '/a.txt', original, { ifAbsent: true });
    assert.equal(recreated.status, 201);

    const deleteReplay = await ctx.client.postMutation(ns, deleteBody, { idempotencyKey: deleteKey });
    assert.equal(deleteReplay.status, 200);
    assert.deepEqual(deleteReplay.json(), deleted.json());
    assert.equal(deleteReplay.headers.get('x-request-id'), deleted.headers.get('x-request-id'));
    assert.deepEqual(
      (await ctx.client.getContent(ns, '/a.txt')).bytes,
      original,
      '재전송이 새 파일을 삭제했다',
    );

    // 같은 키로 대상 경로가 다른 삭제를 보내면 재사용 오류다.
    const otherDelete = await ctx.client.postMutation(
      ns,
      { ...deleteBody, path: '/b.txt' },
      { idempotencyKey: deleteKey },
    );
    assert.equal(otherDelete.status, 409);
    assert.equal(otherDelete.json<{ code: string }>().code, 'MUTATION_KEY_REUSED');
  },
});
