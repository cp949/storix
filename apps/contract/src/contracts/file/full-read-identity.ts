// 소비자 기대: 전체 조회 응답의 파일 ID·revision·SHA-256 헤더가 반환된 바이트의 상태를 식별하고, 디렉터리와 부재를 구분할 수 있다.
// 대응 요구사항: RQ-006(전체 파일 조회). Storix 재시작 후 일관성은 재시작 계약이 맡는다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'full-read-identity',
  title: '전체 조회는 반환한 바이트에 대응하는 파일 ID·revision·SHA-256을 알리고 디렉터리와 부재를 구분한다',
  rq: ['RQ-006'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const first = Buffer.from('첫 번째 상태', 'utf-8');
    const second = Buffer.from('두 번째 상태, 더 긴 본문', 'utf-8');

    // 저장 직후 조회: 헤더가 저장 결과와 반환한 바이트를 식별한다.
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', first, { ifAbsent: true });
    assert.equal(created.status, 201);
    const v1 = created.json<ConditionalResult>().resource;
    const read1 = await ctx.client.getContent(ns, '/doc.txt');
    assert.equal(read1.status, 200);
    assert.deepEqual(read1.bytes, first);
    assert.equal(read1.headers.get('x-storix-file-id'), v1.id);
    assert.equal(read1.headers.get('x-storix-revision'), v1.revision);
    assert.equal(read1.headers.get('x-storix-sha256'), sha256(first));
    assert.equal(read1.headers.get('content-length'), String(first.length));

    // 교체 뒤에는 같은 파일 ID에 새 revision과 새 바이트의 해시가 대응한다.
    const replaced = await ctx.client.putConditionalContent(ns, '/doc.txt', second, {
      ifRevision: v1.revision,
    });
    assert.equal(replaced.status, 200);
    const v2 = replaced.json<ConditionalResult>().resource;
    const read2 = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(read2.bytes, second);
    assert.equal(read2.headers.get('x-storix-file-id'), v1.id);
    assert.equal(read2.headers.get('x-storix-revision'), v2.revision);
    assert.notEqual(v2.revision, v1.revision);
    assert.equal(read2.headers.get('x-storix-sha256'), sha256(second));

    // 디렉터리와 없는 경로는 서로 다른 오류다.
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    const directory = await ctx.client.getContent(ns, '/dir');
    const missing = await ctx.client.getContent(ns, '/missing.txt');
    assert.equal(missing.status, 404);
    assert.equal(missing.json<{ code: string }>().code, 'VFS_NODE_NOT_FOUND');
    assert.equal(directory.status, 409);
    assert.equal(directory.json<{ code: string }>().code, 'VFS_IS_DIRECTORY');
  },
});
