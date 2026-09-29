// 소비자 기대: namespace 저장량 상한 변경은 관리자 key로만 되고, 잘못된 요청은 안정적인 코드로 거부되며 상한을 바꾸지 않고, 같은 Idempotency-Key의 같은 요청은 같은 결과를 재생한다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류). 상한 재정의의 효과는 `namespace-quota-override`가 다룬다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

function assertError(response: ApiResponse, status: number, code: string, label: string): void {
  assert.equal(response.status, status, `${label}: ${response.text()}`);
  assert.equal(response.json<{ code: string }>().code, code, label);
}

export default defineContract({
  id: 'namespace-quota-admin-errors',
  title:
    'quota 변경 API는 관리자 key만 받고 잘못된 요청을 코드로 구분해 거부하며 같은 키의 같은 요청은 결과를 재생한다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const limitOf = async (): Promise<string> =>
      (await ctx.client.getNamespace(ns)).json<{ quota: { limitBytes: string } }>().quota.limitBytes;
    assert.equal(await limitOf(), '2000');

    // 서비스 key나 틀린 key로는 상한을 바꿀 수 없다.
    for (const [label, key] of [
      ['서비스 key', ctx.apiKey],
      ['틀린 key', 'wrong-admin-key'],
    ] as const) {
      const response = await ctx.client.updateNamespaceQuota(ns, key, { maxTotalLogicalBytes: '1000' });
      assertError(response, 401, 'UNAUTHORIZED', label);
    }

    // 형식이 틀린 값은 400 NAMESPACE_INVALID_TOTAL_LOGICAL_BYTES다: 0, 숫자형, 선행 0, 필드 누락.
    const invalidBodies: Array<[string, object]> = [
      ['0', { maxTotalLogicalBytes: '0' }],
      ['숫자형', { maxTotalLogicalBytes: 1000 }],
      ['선행 0', { maxTotalLogicalBytes: '0100' }],
      ['필드 누락', {}],
    ];
    for (const [label, body] of invalidBodies) {
      const response = await ctx.client.updateNamespaceQuota(ns, ctx.adminKey, body);
      assertError(response, 400, 'NAMESPACE_INVALID_TOTAL_LOGICAL_BYTES', label);
    }

    // Idempotency-Key가 없으면 400 IDEMPOTENCY_KEY_REQUIRED다.
    const noKey = await ctx.client.updateNamespaceQuota(
      ns,
      ctx.adminKey,
      { maxTotalLogicalBytes: '1000' },
      { idempotencyKey: null },
    );
    assertError(noKey, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'key 없음');

    // 없는 namespace는 404 NAMESPACE_NOT_FOUND다.
    const missing = await ctx.client.updateNamespaceQuota(randomUUID(), ctx.adminKey, {
      maxTotalLogicalBytes: '1000',
    });
    assertError(missing, 404, 'NAMESPACE_NOT_FOUND', '없는 namespace');

    // 위 거부는 모두 상한을 바꾸지 않았다.
    assert.equal(await limitOf(), '2000');

    // 같은 key의 같은 요청은 변경을 한 번만 적용하고 같은 결과를 돌려준다.
    const key = randomUUID();
    const first = await ctx.client.updateNamespaceQuota(
      ns,
      ctx.adminKey,
      { maxTotalLogicalBytes: '1500' },
      { idempotencyKey: key },
    );
    assert.equal(first.status, 200, first.text());
    const replay = await ctx.client.updateNamespaceQuota(
      ns,
      ctx.adminKey,
      { maxTotalLogicalBytes: '1500' },
      { idempotencyKey: key },
    );
    assert.equal(replay.status, 200, replay.text());
    assert.equal(replay.json<{ quota: { limitBytes: string } }>().quota.limitBytes, '1500');

    // 같은 key를 다른 요청에 다시 쓰면 422 IDEMPOTENCY_KEY_REUSED이고 상한은 첫 요청 그대로다.
    const reused = await ctx.client.updateNamespaceQuota(
      ns,
      ctx.adminKey,
      { maxTotalLogicalBytes: '1600' },
      { idempotencyKey: key },
    );
    assertError(reused, 422, 'IDEMPOTENCY_KEY_REUSED', 'key 재사용');
    assert.equal(await limitOf(), '1500');
  },
});
