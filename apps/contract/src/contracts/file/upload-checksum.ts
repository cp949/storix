// 소비자 기대: 업로드에 전체 SHA-256을 지정하면 일치할 때만 저장되고, 불일치·형식 오류는 기존 파일을 바꾸지 않은 채 코드로 구분되어 거부된다.
// 대응 요구사항: RQ-028(업로드 전체 checksum 검증).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface ConditionalResult {
  resource: { revision: string };
}

export default defineContract({
  id: 'upload-checksum',
  title: '일치하는 checksum만 저장하고, 불일치는 422·형식 오류는 400으로 기존 파일 변경 없이 거부한다',
  rq: ['RQ-028'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const original = Buffer.from('원래 내용', 'utf-8');
    const created = await ctx.client.putConditionalContent(
      ns,
      '/doc.txt',
      original,
      {
        ifAbsent: true,
        // 생략한 기존 요청과 같은 동작은 다른 계약이 다룬다. 여기서는 정상 checksum의 생성을 확인한다.
      },
      { expectedSha256: sha256(original) },
    );
    assert.equal(created.status, 201);
    const revision = created.json<ConditionalResult>().resource.revision;

    const next = Buffer.from('교체할 내용', 'utf-8');
    const wrong = sha256(Buffer.from('다른 바이트', 'utf-8'));

    // 계산값과 다른 checksum은 422이고 파일 바이트·revision이 그대로다. 응답은 기대값·계산값을 노출하지 않는다.
    const key = randomUUID();
    const mismatch = await ctx.client.putConditionalContent(
      ns,
      '/doc.txt',
      next,
      { ifRevision: revision },
      { expectedSha256: wrong, idempotencyKey: key },
    );
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.json<{ code: string }>().code, 'VFS_CHECKSUM_MISMATCH');
    assert.ok(!mismatch.text().includes(wrong), '기대 checksum이 응답에 없어야 한다');
    assert.ok(!mismatch.text().includes(sha256(next)), '계산된 checksum이 응답에 없어야 한다');
    const unchanged = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(unchanged.bytes, original);
    assert.equal(unchanged.headers.get('x-storix-revision'), revision);

    // 같은 key의 같은 요청은 최초 422를 재생한다.
    const replay = await ctx.client.putConditionalContent(
      ns,
      '/doc.txt',
      next,
      { ifRevision: revision },
      { expectedSha256: wrong, idempotencyKey: key },
    );
    assert.equal(replay.status, 422);
    assert.equal(replay.json<{ code: string }>().code, 'VFS_CHECKSUM_MISMATCH');
    assert.equal(replay.headers.get('x-request-id'), mismatch.headers.get('x-request-id'));

    // 새 경로에 대한 불일치도 경로를 만들지 않는다.
    const rejectedNew = await ctx.client.putConditionalContent(
      ns,
      '/new.txt',
      next,
      { ifAbsent: true },
      { expectedSha256: wrong },
    );
    assert.equal(rejectedNew.status, 422);
    assert.equal((await ctx.client.getStat(ns, '/new.txt')).status, 404);

    // 64자리 소문자 hex가 아닌 표현은 400이고 파일은 그대로다.
    const malformed = [sha256(next).toUpperCase(), sha256(next).slice(0, 63), 'not-a-checksum'];
    for (const value of malformed) {
      const response = await ctx.client.putConditionalContent(
        ns,
        '/doc.txt',
        next,
        { ifRevision: revision },
        { expectedSha256: value },
      );
      assert.equal(response.status, 400, value);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_CHECKSUM', value);
    }
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.txt')).bytes, original);

    // 올바른 checksum으로 교체하면 저장되고 revision이 바뀐다.
    const replaced = await ctx.client.putConditionalContent(
      ns,
      '/doc.txt',
      next,
      { ifRevision: revision },
      { expectedSha256: sha256(next) },
    );
    assert.equal(replaced.status, 200);
    const after = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(after.bytes, next);
    assert.notEqual(after.headers.get('x-storix-revision'), revision);
  },
});
