// 소비자 기대: snapshot이 보유하는 바이트를 더한 사용량이 저장량 상한을 넘으면 snapshot 생성은 한도 유형을 알 수 있는 오류로 거부되고, 기존 snapshot·파일·사용량은 변하지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류). 한도 값은 `small-limits` 프로필(runner/profiles.ts)이 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'snapshot-create-quota-rejection',
  title: '저장량 상한을 넘는 snapshot 생성은 413 VFS_QUOTA_EXCEEDED로 거부하고 사용량을 바꾸지 않는다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const used = async (): Promise<string> =>
      (await ctx.client.getNamespace(ns)).json<{ quota: { usedBytes: string } }>().quota.usedBytes;

    // 700바이트 파일과 첫 snapshot은 합계 1400으로 상한(2000) 안이다.
    const stored = await ctx.client.putConditionalContent(ns, '/doc.bin', Buffer.alloc(700, 0x61), {
      ifAbsent: true,
    });
    assert.equal(stored.status, 201, stored.text());
    const first = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.bin' });
    assert.equal(first.status, 201, first.text());
    assert.equal(await used(), '1400');

    // 두 번째 snapshot은 snapshot 크기 상한(800) 안이지만 합계가 2100이 되어 거부된다.
    const rejected = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.bin' });
    assert.equal(rejected.status, 413, rejected.text());
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_QUOTA_EXCEEDED');
    assert.equal(await used(), '1400');
    assert.equal((await ctx.client.getContent(ns, '/doc.bin')).bytes.length, 700);
  },
});
