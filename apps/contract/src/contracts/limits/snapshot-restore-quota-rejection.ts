// 소비자 기대: 복원 결과가 저장량 상한을 넘으면 한도 유형을 알 수 있는 오류로 거부되고, 대상 경로·snapshot·사용량은 변하지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'snapshot-restore-quota-rejection',
  title:
    '저장량 상한을 넘는 snapshot 복원은 413 VFS_QUOTA_EXCEEDED로 거부하고 대상 경로·snapshot·사용량을 바꾸지 않는다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const used = async (): Promise<string> =>
      (await ctx.client.request('GET', `/api/v2/namespaces/${ns}`)).json<{ quota: { usedBytes: string } }>()
        .quota.usedBytes;

    // 700바이트 파일과 그 snapshot은 합계 1400이다. 새 경로로 복원하면 2100이 되어 상한(2000)을 넘는다.
    const file = Buffer.alloc(700, 0x61);
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', file, { ifAbsent: true });
    assert.equal(created.status, 201);
    const resource = created.json<ConditionalResult>().resource;
    const snapshotResponse = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.txt' });
    assert.equal(snapshotResponse.status, 201);
    const snapshotId = snapshotResponse.json<{ snapshotId: string }>().snapshotId;
    assert.equal(await used(), '1400');

    const rejected = await ctx.client.restoreSnapshot(ns, snapshotId, {
      path: '/restored.txt',
      ifAbsent: true,
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_QUOTA_EXCEEDED');

    // 복원 대상 경로가 생기지 않았고, 원본 파일·snapshot·사용량이 그대로다.
    assert.equal((await ctx.client.getStat(ns, '/restored.txt')).status, 404);
    const original = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(original.bytes, file);
    assert.equal(original.headers.get('x-storix-revision'), resource.revision);
    assert.equal((await ctx.client.getSnapshot(ns, snapshotId)).status, 200);
    assert.deepEqual((await ctx.client.getSnapshotContent(ns, snapshotId)).bytes, file);
    assert.equal(await used(), '1400');
  },
});
