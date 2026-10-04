// 소비자 기대: 파라미터를 뗀 Content-Type이 255자까지는 그대로 저장되고, 255자를 넘으면 application/octet-stream으로 저장되며 어느 경우에도 5xx가 아니다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Stat {
  mimeType: string | null;
}

export default defineContract({
  id: 'content-type-length',
  title:
    '파라미터를 뗀 Content-Type이 255자면 그대로, 256자면 application/octet-stream으로 저장하고, 조건부·무조건 저장 모두 5xx가 나지 않는다',
  rq: ['RQ-007', 'RQ-009', 'RQ-018'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const atLimit = `application/${'x'.repeat(243)}`;
    const overLimit = `application/${'x'.repeat(244)}`;
    assert.equal(atLimit.length, 255);
    assert.equal(overLimit.length, 256);
    const body = Buffer.from('mime length');
    const mimeOf = async (path: string): Promise<string | null> => {
      const stat = await ctx.client.getStat(ns, path);
      assert.equal(stat.status, 200, stat.text());
      return stat.json<Stat>().mimeType;
    };
    const putUnconditional = (path: string, contentType: string) =>
      ctx.client.request('POST', `/api/v2/namespaces/${ns}/fs/content?path=${encodeURIComponent(path)}`, {
        headers: { 'Content-Type': contentType },
        body,
      });

    const conditionalAt = await ctx.client.putConditionalContent(
      ns,
      '/cond-at.bin',
      body,
      { ifAbsent: true },
      {
        contentType: atLimit,
      },
    );
    assert.equal(conditionalAt.status, 201, conditionalAt.text());
    assert.equal(await mimeOf('/cond-at.bin'), atLimit);

    const conditionalOver = await ctx.client.putConditionalContent(
      ns,
      '/cond-over.bin',
      body,
      { ifAbsent: true },
      { contentType: overLimit },
    );
    assert.equal(conditionalOver.status, 201, conditionalOver.text());
    assert.equal(await mimeOf('/cond-over.bin'), 'application/octet-stream');

    // 파라미터가 길어도 뗀 값이 255자 이하면 통과한다.
    const withParams = await ctx.client.putConditionalContent(
      ns,
      '/cond-params.bin',
      body,
      { ifAbsent: true },
      { contentType: `${atLimit}; charset=${'y'.repeat(300)}` },
    );
    assert.equal(withParams.status, 201, withParams.text());
    assert.equal(await mimeOf('/cond-params.bin'), atLimit);

    const plainAt = await putUnconditional('/plain-at.bin', atLimit);
    assert.equal(plainAt.status, 201, plainAt.text());
    assert.equal(await mimeOf('/plain-at.bin'), atLimit);

    const plainOver = await putUnconditional('/plain-over.bin', overLimit);
    assert.equal(plainOver.status, 201, plainOver.text());
    assert.equal(await mimeOf('/plain-over.bin'), 'application/octet-stream');
  },
});
