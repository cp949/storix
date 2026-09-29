// 소비자 기대: 파일 일부를 byte range로 받으면 지정 구간의 바이트·길이·Content-Range가 맞고, 어느 파일의 어느 revision인지 식별되며, 처리할 수 없는 범위는 416으로 거부된다.
// 대응 요구사항: RQ-021(Range 부분 콘텐츠 조회).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export default defineContract({
  id: 'range-content',
  title:
    'Range 조회는 206으로 지정 구간과 파일 ID·revision을 돌려주고, 처리할 수 없는 범위는 416으로 거부한다',
  rq: ['RQ-021'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    // 바이트 값이 위치마다 달라 구간이 어긋나면 바로 드러난다.
    const file = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
    const created = await ctx.client.putConditionalContent(ns, '/data.bin', file, { ifAbsent: true });
    assert.equal(created.status, 201);
    const full = await ctx.client.getContent(ns, '/data.bin');
    const fileId = full.headers.get('x-storix-file-id');
    const revision = full.headers.get('x-storix-revision');
    assert.ok(fileId !== null && revision !== null);
    const fullSha256 = sha256(file);

    const partial = async (range: string) =>
      ctx.client.getContent(ns, '/data.bin', { headers: { Range: range } });

    // 시작-끝, 열린 끝, suffix, 끝을 넘는 범위(파일 끝으로 잘림)가 각각 지정 구간을 돌려준다.
    const accepted: Array<[string, number, number]> = [
      ['bytes=2-5', 2, 5],
      ['bytes=10-', 10, 99],
      ['bytes=-5', 95, 99],
      ['bytes=90-1000', 90, 99],
      ['bytes=0-0', 0, 0],
    ];
    for (const [range, start, end] of accepted) {
      const response = await partial(range);
      assert.equal(response.status, 206, range);
      assert.deepEqual(response.bytes, file.subarray(start, end + 1), range);
      assert.equal(response.headers.get('content-length'), String(end - start + 1), range);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/100`, range);
      // 부분 응답도 어느 파일의 어느 revision인지 식별한다.
      assert.equal(response.headers.get('x-storix-file-id'), fileId, range);
      assert.equal(response.headers.get('x-storix-revision'), revision, range);
      // 전체 파일 해시 헤더가 있다면 부분 바이트의 해시로 바뀌어 있으면 안 된다.
      const sha = response.headers.get('x-storix-sha256');
      if (sha !== null) assert.equal(sha, fullSha256, `${range}: 전체 SHA-256 의미 유지`);
    }

    // 처리할 수 없는 범위는 416이고 본문이 바이트를 노출하지 않는다.
    const rejected = ['bytes=100-', 'bytes=500-600', 'bytes=abc', 'bytes=0-1,5-6', 'items=0-1'];
    for (const range of rejected) {
      const response = await partial(range);
      assert.equal(response.status, 416, range);
      assert.ok(
        ['VFS_INVALID_RANGE', 'VFS_RANGE_NOT_SATISFIABLE'].includes(response.json<{ code: string }>().code),
        `${range}: ${response.text()}`,
      );
    }

    // Range를 주지 않은 전체 조회는 200이고 그대로다.
    assert.deepEqual((await ctx.client.getContent(ns, '/data.bin')).bytes, file);
  },
});
