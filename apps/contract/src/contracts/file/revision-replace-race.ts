// 소비자 기대: 같은 revision을 조건으로 한 동시 교체는 한 건만 성공하고 조용한 마지막 쓰기 승리가 없다.
// 대응 요구사항: RQ-008(revision 조건부 전체 교체). 재시작을 포함하는 RQ-010은 재시작 계약이 맡는다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { revision: string };
}

export default defineContract({
  id: 'revision-replace-race',
  title: '같은 revision을 조건으로 한 동시 교체는 한 건만 성공하고 성공한 바이트만 남는다',
  rq: ['RQ-008'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    const created = await ctx.client.putConditionalContent(ns, '/race.bin', randomBytes(1024), {
      ifAbsent: true,
    });
    const v1 = created.json<ConditionalResult>().resource;

    const contenders = Array.from({ length: 4 }, () => randomBytes(256 * 1024));
    const attempts = await Promise.all(
      contenders.map((bytes) =>
        ctx.client.putConditionalContent(ns, '/race.bin', bytes, { ifRevision: v1.revision }),
      ),
    );

    // 성공은 정확히 한 건이고 나머지는 412다.
    const statuses = attempts.map((attempt) => attempt.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 412, 412, 412], `성공 1건, 충돌 3건이어야 한다: ${statuses.join(', ')}`);

    // 성공한 요청의 바이트와 revision이 그대로 남는다.
    const winner = attempts.findIndex((attempt) => attempt.status === 200);
    const winnerRevision = attempts[winner].json<ConditionalResult>().resource.revision;
    const read = await ctx.client.getContent(ns, '/race.bin');
    assert.deepEqual(read.bytes, contenders[winner]);
    assert.equal(read.headers.get('x-storix-revision'), winnerRevision);
    assert.notEqual(winnerRevision, v1.revision);
  },
});
