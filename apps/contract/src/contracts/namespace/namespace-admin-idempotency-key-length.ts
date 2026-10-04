// 소비자 기대: 관리자 PATCH(quota·trash)의 Idempotency-Key는 255 byte까지 쓸 수 있고, 255 byte를 넘으면 5xx가 아니라 400으로 거절되며 설정은 바뀌지 않는다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성), RQ-018(안정적인 오류 분류). 공개 openapi의 `Idempotency-Key` `maxLength: 255`와 같다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-admin-idempotency-key-length',
  title:
    'namespace quota·휴지통 정책 PATCH는 255 byte Idempotency-Key로 성공·재생되고, 256 byte 키는 설정을 바꾸지 않고 400 IDEMPOTENCY_KEY_REQUIRED로 거절한다',
  rq: ['RQ-011', 'RQ-018'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const trashEnabled = async (): Promise<boolean> => {
      const response = await ctx.client.getNamespace(ns);
      assert.equal(response.status, 200, response.text());
      return response.json<{ quota: { trash: { enabled: boolean } } }>().quota.trash.enabled;
    };
    const key = 'k'.repeat(255);
    const tooLong = 'k'.repeat(256);

    // 휴지통 정책: 255 byte 키는 적용·재생되고 256 byte 키는 정책을 바꾸지 않는다.
    const enabled = await ctx.client.updateNamespaceTrashPolicy(
      ns,
      ctx.adminKey,
      { enabled: true },
      { idempotencyKey: key },
    );
    assert.equal(enabled.status, 200, enabled.text());
    const replay = await ctx.client.updateNamespaceTrashPolicy(
      ns,
      ctx.adminKey,
      { enabled: true },
      { idempotencyKey: key },
    );
    assert.equal(replay.status, 200, replay.text());
    assert.deepEqual(replay.json(), enabled.json());
    const trashRejected = await ctx.client.updateNamespaceTrashPolicy(
      ns,
      ctx.adminKey,
      { enabled: false },
      { idempotencyKey: tooLong },
    );
    assert.equal(trashRejected.status, 400, trashRejected.text());
    assert.equal(trashRejected.json<{ code: string }>().code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(await trashEnabled(), true);

    // quota: 255 byte 키는 적용·재생되고 256 byte 키는 400이다. 값은 기본값 상속(null)만 쓴다.
    const quota = await ctx.client.updateNamespaceQuota(
      ns,
      ctx.adminKey,
      { maxTotalLogicalBytes: null },
      { idempotencyKey: key },
    );
    assert.equal(quota.status, 200, quota.text());
    const quotaReplay = await ctx.client.updateNamespaceQuota(
      ns,
      ctx.adminKey,
      { maxTotalLogicalBytes: null },
      { idempotencyKey: key },
    );
    assert.equal(quotaReplay.status, 200, quotaReplay.text());
    assert.deepEqual(quotaReplay.json(), quota.json());
    const quotaRejected = await ctx.client.updateNamespaceQuota(
      ns,
      ctx.adminKey,
      { maxTotalLogicalBytes: null },
      { idempotencyKey: tooLong },
    );
    assert.equal(quotaRejected.status, 400, quotaRejected.text());
    assert.equal(quotaRejected.json<{ code: string }>().code, 'IDEMPOTENCY_KEY_REQUIRED');
  },
});
