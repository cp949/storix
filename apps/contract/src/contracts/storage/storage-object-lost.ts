// 소비자 기대: 메타데이터가 가리키는 객체를 저장소가 잃으면 조회는 500 STORAGE_FAILURE로 거부되고 저장소 내부 정보를 노출하지 않으며, 재시도해도 같은 결과이고 다른 경로의 새 저장은 계속 된다.
// 대응 요구사항: RQ-018(안정적인 오류 분류: 확정된 저장 장애는 재시도 가능한 일시 오류와 구분).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

/** 500 응답이 STORAGE_FAILURE를 알리고 저장소 내부 정보를 노출하지 않는지 확인한다. */
function assertStorageFailure(response: ApiResponse, label: string): void {
  assert.equal(response.status, 500, `${label}: ${response.text()}`);
  assert.equal(response.json<{ code: string }>().code, 'STORAGE_FAILURE', label);
  assert.doesNotMatch(response.text(), /127\.0\.0\.1|NoSuchKey|NoSuchBucket|versity/i, label);
}

export default defineContract({
  id: 'storage-object-lost',
  title:
    '저장소가 객체를 잃으면 조회는 500 STORAGE_FAILURE로 거부되고 재시도해도 같으며 다른 경로의 새 저장은 계속 된다',
  rq: ['RQ-018'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const lost = Buffer.from(`사라질 파일 ${randomUUID()}`, 'utf-8');
    assert.equal(
      (await ctx.client.putConditionalContent(ns, '/lost.bin', lost, { ifAbsent: true })).status,
      201,
    );

    // 저장소가 객체를 잃으면 조회는 확정된 저장 장애로 거부된다. 일시 장애(503)가 아니므로 재시도해도 같다.
    await ctx.blobStorage.deleteAllObjects();
    assertStorageFailure(await ctx.client.getContent(ns, '/lost.bin'), '첫 조회');
    assertStorageFailure(await ctx.client.getContent(ns, '/lost.bin'), '재시도 조회');

    // 메타데이터는 남아 있고 다른 경로의 새 저장과 조회는 정상이다.
    assert.equal((await ctx.client.getStat(ns, '/lost.bin')).status, 200);
    const fresh = Buffer.from(`새 파일 ${randomUUID()}`, 'utf-8');
    const created = await ctx.client.putConditionalContent(ns, '/fresh.bin', fresh, { ifAbsent: true });
    assert.equal(created.status, 201, created.text());
    const read = await ctx.client.getContent(ns, '/fresh.bin');
    assert.equal(read.status, 200);
    assert.deepEqual(read.bytes, fresh);
  },
});
