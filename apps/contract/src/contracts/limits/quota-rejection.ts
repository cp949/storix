// 소비자 기대: namespace 저장량 상한을 넘는 저장은 한도 유형을 알 수 있는 오류로 거부되고, 기존 파일과 사용량은 변하지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'quota-rejection',
  title: '저장량 상한 초과 저장은 413 VFS_QUOTA_EXCEEDED로 거부하고 기존 파일과 사용량을 바꾸지 않는다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const used = async (): Promise<string> =>
      (await ctx.client.request('GET', `/api/v2/namespaces/${ns}`)).json<{ quota: { usedBytes: string } }>()
        .quota.usedBytes;

    // 700바이트 파일 두 개는 상한(2000) 안이다.
    const first = Buffer.alloc(700, 0x61);
    const second = Buffer.alloc(700, 0x62);
    assert.equal(
      (await ctx.client.putConditionalContent(ns, '/a.bin', first, { ifAbsent: true })).status,
      201,
    );
    assert.equal(
      (await ctx.client.putConditionalContent(ns, '/b.bin', second, { ifAbsent: true })).status,
      201,
    );
    assert.equal(await used(), '1400');

    // 세 번째 파일은 파일 크기 상한 안이지만 합계가 2100이 되어 거부되고 경로가 생기지 않는다.
    const rejected = await ctx.client.putConditionalContent(ns, '/c.bin', Buffer.alloc(700, 0x63), {
      ifAbsent: true,
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_QUOTA_EXCEEDED');
    assert.equal((await ctx.client.getStat(ns, '/c.bin')).status, 404);
    assert.equal(await used(), '1400');

    // 기존 두 파일은 그대로다.
    assert.deepEqual((await ctx.client.getContent(ns, '/a.bin')).bytes, first);
    assert.deepEqual((await ctx.client.getContent(ns, '/b.bin')).bytes, second);

    // 합계가 상한 안이면 다시 저장할 수 있다(거부가 namespace를 막지 않는다).
    const fits = await ctx.client.putConditionalContent(ns, '/d.bin', Buffer.alloc(600, 0x64), {
      ifAbsent: true,
    });
    assert.equal(fits.status, 201);
    assert.equal(await used(), '2000');
  },
});
