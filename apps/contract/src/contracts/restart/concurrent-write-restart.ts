// 소비자 기대: 같은 revision을 조건으로 한 동시 교체에서 성공한 결과만 남고, 재시작 뒤에도 그 결과가 유지된다.
// 대응 요구사항: RQ-010(순서와 재시작 후 지속성).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { revision: string };
}

export default defineContract({
  id: 'concurrent-write-restart',
  title: '동시 교체의 승자 하나만 재시작 뒤에도 남고 조용한 마지막 쓰기 승리가 없다',
  rq: ['RQ-010'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    const created = await ctx.client.putConditionalContent(ns, '/race.bin', randomBytes(1024), {
      ifAbsent: true,
    });
    const v1 = created.json<ConditionalResult>().resource;

    const contenders = Array.from({ length: 4 }, () => randomBytes(128 * 1024));
    const attempts = await Promise.all(
      contenders.map((bytes) =>
        ctx.client.putConditionalContent(ns, '/race.bin', bytes, { ifRevision: v1.revision }),
      ),
    );
    const statuses = attempts.map((attempt) => attempt.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 412, 412, 412], `성공 1건, 충돌 3건이어야 한다: ${statuses.join(', ')}`);
    const winner = attempts.findIndex((attempt) => attempt.status === 200);
    const winnerRevision = attempts[winner].json<ConditionalResult>().resource.revision;

    await ctx.server.restart();

    // 재시작 뒤에도 승자의 바이트와 revision이 그대로이고, 패자의 바이트는 나타나지 않는다.
    const read = await ctx.client.getContent(ns, '/race.bin');
    assert.equal(read.status, 200);
    assert.deepEqual(read.bytes, contenders[winner]);
    assert.equal(read.headers.get('x-storix-revision'), winnerRevision);
    assert.equal(
      (await ctx.client.getStat(ns, '/race.bin')).json<{ revision: string }>().revision,
      winnerRevision,
    );

    // 이미 지나간 revision은 재시작 뒤에도 충돌이고, 승자 revision을 조건으로 하면 이어서 교체된다.
    const stale = await ctx.client.putConditionalContent(ns, '/race.bin', randomBytes(16), {
      ifRevision: v1.revision,
    });
    assert.equal(stale.status, 412);
    const next = await ctx.client.putConditionalContent(ns, '/race.bin', randomBytes(16), {
      ifRevision: winnerRevision,
    });
    assert.equal(next.status, 200);
  },
});
