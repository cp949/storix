// 소비자 기대: snapshot 크기 상한을 넘는 생성은 한도 유형을 알 수 있는 오류로 거부되고, snapshot·현재 파일·사용량은 변하지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'snapshot-limit-rejection',
  title: 'snapshot 크기 상한 초과 생성은 413 VFS_SNAPSHOT_LIMIT_EXCEEDED로 거부하고 아무것도 바꾸지 않는다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const used = async (): Promise<string> =>
      (await ctx.client.request('GET', `/api/v2/namespaces/${ns}`)).json<{ quota: { usedBytes: string } }>()
        .quota.usedBytes;

    // 파일 크기 상한(1200)과 저장량 상한(2000) 안이지만 snapshot 상한(800)을 넘는 900바이트 파일이다.
    const file = Buffer.alloc(900, 0x61);
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', file, { ifAbsent: true });
    assert.equal(created.status, 201);
    const resource = created.json<ConditionalResult>().resource;

    const rejected = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.txt' });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_SNAPSHOT_LIMIT_EXCEEDED');

    // snapshot이 생기지 않았고 사용량과 현재 파일이 그대로다.
    const listed = await ctx.client.listSnapshots(ns, resource.id);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json<{ items: unknown[] }>().items, []);
    assert.equal(await used(), '900');
    const unchanged = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(unchanged.bytes, file);
    assert.equal(unchanged.headers.get('x-storix-revision'), resource.revision);
  },
});
