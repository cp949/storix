// 소비자 기대: 저장소가 일시적으로 멈추면 저장·조회가 503 STORAGE_UNAVAILABLE로 거부되고 아무것도 만들어지지 않으며, 저장소가 돌아온 뒤 같은 Idempotency-Key로 다시 보내면 성공하고 기존 파일은 그대로다.
// 대응 요구사항: RQ-018(안정적인 오류 분류: 재시도 가능한 일시 오류), RQ-011(변경 요청의 멱등성). `Retry-After`는 있을 때만 준수하는 값이라 단언하지 않는다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

/** 503 응답이 안정적인 code를 알리고 저장소 내부 정보를 노출하지 않는지 확인한다. */
function assertUnavailable(response: ApiResponse, label: string): void {
  assert.equal(response.status, 503, `${label}: ${response.text()}`);
  assert.equal(response.json<{ code: string }>().code, 'STORAGE_UNAVAILABLE', label);
  assert.doesNotMatch(response.text(), /127\.0\.0\.1|ECONNREFUSED|versity/i, label);
}

export default defineContract({
  id: 'storage-unavailable-retry',
  title:
    '저장소가 멈춘 동안 저장·조회는 503 STORAGE_UNAVAILABLE로 거부되고, 복구 뒤 같은 key의 재시도는 성공하며 기존 파일은 그대로다',
  rq: ['RQ-011', 'RQ-018'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const existing = Buffer.from(`기존 파일 ${randomUUID()}`, 'utf-8');
    const stored = await ctx.client.putConditionalContent(ns, '/existing.bin', existing, { ifAbsent: true });
    assert.equal(stored.status, 201);

    // 저장소가 멈춘 동안 새 파일 저장과 기존 파일 조회는 일시 장애로 거부된다.
    await ctx.blobStorage.stop();
    const key = randomUUID();
    const incoming = Buffer.from(`새 파일 ${key}`, 'utf-8');
    const rejected = await ctx.client.putConditionalContent(
      ns,
      '/incoming.bin',
      incoming,
      { ifAbsent: true },
      { idempotencyKey: key },
    );
    assertUnavailable(rejected, '저장 중 장애');
    assertUnavailable(await ctx.client.getContent(ns, '/existing.bin'), '조회 중 장애');

    // 저장소가 돌아오면 거부된 저장이 아무것도 남기지 않았고 기존 파일은 그대로다.
    await ctx.blobStorage.start();
    assert.equal((await ctx.client.getStat(ns, '/incoming.bin')).status, 404);
    const read = await ctx.client.getContent(ns, '/existing.bin');
    assert.equal(read.status, 200);
    assert.deepEqual(read.bytes, existing);

    // 5xx는 receipt를 남기지 않으므로 같은 key·같은 요청의 재시도가 새로 평가돼 성공한다.
    const retried = await ctx.client.putConditionalContent(
      ns,
      '/incoming.bin',
      incoming,
      { ifAbsent: true },
      { idempotencyKey: key },
    );
    assert.equal(retried.status, 201, retried.text());
    const readBack = await ctx.client.getContent(ns, '/incoming.bin');
    assert.equal(readBack.status, 200);
    assert.deepEqual(readBack.bytes, incoming);
  },
});
