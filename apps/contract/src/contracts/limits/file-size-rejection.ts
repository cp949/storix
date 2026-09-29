// 소비자 기대: 파일 크기 상한을 넘는 저장은 한도 유형을 알 수 있는 오류로 거부되고, 기존 파일·revision·사용량은 변하지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { revision: string };
}

export default defineContract({
  id: 'file-size-rejection',
  title: '파일 크기 상한 초과 저장은 413 VFS_FILE_TOO_LARGE로 거부하고 기존 파일과 사용량을 바꾸지 않는다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const used = async (): Promise<string> =>
      (await ctx.client.request('GET', `/api/v2/namespaces/${ns}`)).json<{ quota: { usedBytes: string } }>()
        .quota.usedBytes;

    const original = Buffer.alloc(700, 0x61);
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', original, { ifAbsent: true });
    assert.equal(created.status, 201);
    const revision = created.json<ConditionalResult>().resource.revision;

    // 상한(1200)을 1바이트 넘는 새 파일은 거부되고 경로가 생기지 않는다.
    const oversize = Buffer.alloc(1201, 0x62);
    const rejectedNew = await ctx.client.putConditionalContent(ns, '/big.bin', oversize, {
      ifAbsent: true,
    });
    assert.equal(rejectedNew.status, 413);
    assert.equal(rejectedNew.json<{ code: string }>().code, 'VFS_FILE_TOO_LARGE');
    assert.equal((await ctx.client.getStat(ns, '/big.bin')).status, 404);

    // 기존 파일을 상한 초과 바이트로 교체하려 해도 거부되고 바이트·revision이 그대로다.
    const rejectedReplace = await ctx.client.putConditionalContent(ns, '/doc.txt', oversize, {
      ifRevision: revision,
    });
    assert.equal(rejectedReplace.status, 413);
    assert.equal(rejectedReplace.json<{ code: string }>().code, 'VFS_FILE_TOO_LARGE');
    const unchanged = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(unchanged.bytes, original);
    assert.equal(unchanged.headers.get('x-storix-revision'), revision);
    assert.equal(await used(), '700');

    // 상한과 같은 크기는 허용된다.
    const atLimit = Buffer.alloc(1200, 0x63);
    const replaced = await ctx.client.putConditionalContent(ns, '/doc.txt', atLimit, {
      ifRevision: revision,
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.txt')).bytes, atLimit);
    assert.equal(await used(), '1200');
  },
});
