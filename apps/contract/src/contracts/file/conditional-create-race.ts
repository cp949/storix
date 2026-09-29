// 소비자 기대: 같은 경로에 대한 동시 조건부 생성은 한 건만 성공하고, 성공한 파일의 바이트는 온전하다.
// 대응 요구사항: RQ-005(존재하지 않는 파일의 조건부 생성).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'conditional-create-race',
  title: '같은 경로의 동시 조건부 생성은 한 건만 성공하고 바이트가 온전하다',
  rq: ['RQ-005'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    // UTF-8이 아닌 임의 바이너리로 바이트 무손실까지 확인한다.
    const payloads = [randomBytes(256 * 1024), randomBytes(256 * 1024)];

    const attempts = await Promise.all(
      payloads.map((bytes) =>
        ctx.client.putConditionalContent(namespace.id, '/race.bin', bytes, { ifAbsent: true }),
      ),
    );

    const statuses = attempts.map((attempt) => attempt.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 412], `성공 1건, 충돌 1건이어야 한다: ${statuses.join(', ')}`);

    // 성공한 요청의 바이트가 그대로 저장돼 있다.
    const winner = attempts.findIndex((attempt) => attempt.status === 201);
    const read = await ctx.client.getContent(namespace.id, '/race.bin');
    assert.equal(read.status, 200);
    assert.deepEqual(read.bytes, payloads[winner]);
  },
});
