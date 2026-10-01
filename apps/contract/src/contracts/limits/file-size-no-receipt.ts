// 소비자 기대: 파일 크기 상한을 넘어 413으로 거부된 요청은 멱등성 receipt를 남기지 않아, 같은 키로 상한 안의 요청을 다시 보내면 새로 평가돼 처리된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성: 크기 상한 초과 스트림은 receipt 없음), RQ-017(크기 및 저장량 한도).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'file-size-no-receipt',
  title:
    '크기 상한 초과로 거부된 요청은 receipt를 남기지 않아 같은 키의 상한 안 요청이 409 재사용이 아니라 정상 처리된다',
  rq: ['RQ-011', 'RQ-017'],
  profile: 'small-limits',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const key = randomUUID();

    // 상한(1200)을 넘는 요청은 413이고 경로가 생기지 않는다.
    const oversize = Buffer.alloc(1201, 0x62);
    const rejected = await ctx.client.putConditionalContent(
      ns,
      '/doc.bin',
      oversize,
      { ifAbsent: true },
      { idempotencyKey: key },
    );
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_FILE_TOO_LARGE');
    assert.equal((await ctx.client.getStat(ns, '/doc.bin')).status, 404);

    // 같은 키의 같은 요청은 receipt 재생이 아니라 다시 평가돼도 같은 413이다. 최초 응답 bytes의 동일성은 보장하지 않는다.
    const again = await ctx.client.putConditionalContent(
      ns,
      '/doc.bin',
      oversize,
      { ifAbsent: true },
      { idempotencyKey: key },
    );
    assert.equal(again.status, 413);
    assert.equal(again.json<{ code: string }>().code, 'VFS_FILE_TOO_LARGE');

    // receipt가 있었다면 본문이 다른 같은 키는 409 MUTATION_KEY_REUSED다. 없으므로 상한 안 요청이 새로 처리된다.
    const fits = Buffer.alloc(700, 0x63);
    const created = await ctx.client.putConditionalContent(
      ns,
      '/doc.bin',
      fits,
      { ifAbsent: true },
      { idempotencyKey: key },
    );
    assert.equal(created.status, 201, created.text());
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.bin')).bytes, fits);

    // 정상 처리한 뒤에는 receipt가 생겨 같은 요청의 재전송이 최초 결과를 재생한다.
    const replay = await ctx.client.putConditionalContent(
      ns,
      '/doc.bin',
      fits,
      { ifAbsent: true },
      { idempotencyKey: key },
    );
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.json(), created.json());
    assert.equal(replay.headers.get('x-request-id'), created.headers.get('x-request-id'));
  },
});
