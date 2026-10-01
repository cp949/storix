// 소비자 기대: PUBLIC namespace의 파일은 인증 없이 공개 경로로 전체·Range 조회와 다운로드를 할 수 있고, 인증 경로와 같은 바이트·파일 ID·revision을 돌려주며 잘못된 요청은 인증 경로와 같은 오류로 거부된다.
// 대응 요구사항: RQ-003(경로 계약), RQ-006(전체 파일 조회), RQ-021(Range 부분 콘텐츠 조회).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse, ContractContext } from '../../define-contract.ts';

/** 자격 없이 공개 경로를 조회한다. */
async function anonymousGet(
  ctx: ContractContext,
  path: string,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const response = await fetch(`${ctx.baseUrl}${path}`, { signal: ctx.signal, headers });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text: () => bytes.toString('utf-8'),
    json: <T = unknown>() => JSON.parse(bytes.toString('utf-8')) as T,
  };
}

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'public-namespace-read',
  title:
    'PUBLIC namespace는 인증 없이 공개 경로로 전체·Range 조회와 다운로드를 하고, 인증 경로와 같은 바이트·식별자를 돌려주며 잘못된 요청은 거부한다',
  rq: ['RQ-003', 'RQ-006', 'RQ-021'],
  async run(ctx) {
    const ns = (await ctx.createNamespace({ accessPolicy: 'PUBLIC' })).id;
    assert.equal((await ctx.client.getNamespace(ns)).json<{ accessPolicy: string }>().accessPolicy, 'PUBLIC');

    // 바이트 값이 위치마다 달라 구간이 어긋나면 바로 드러난다.
    const file = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
    const created = await ctx.client.putConditionalContent(ns, '/data.bin', file, { ifAbsent: true });
    assert.equal(created.status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    const authed = await ctx.client.getContent(ns, '/data.bin');
    const fileId = authed.headers.get('x-storix-file-id');
    const revision = authed.headers.get('x-storix-revision');
    assert.ok(fileId !== null && revision !== null);

    const publicUrl = (route: 'content' | 'download', filePath: string): string =>
      `/api/v2/public/${ns}/fs/${route}?path=${encodeURIComponent(filePath)}`;

    // 전체 조회와 다운로드는 자격 없이 200이고 인증 경로와 같은 바이트다.
    const full = await anonymousGet(ctx, publicUrl('content', '/data.bin'));
    assert.equal(full.status, 200);
    assert.deepEqual(full.bytes, file);
    assert.equal(full.headers.get('content-length'), '100');
    const download = await anonymousGet(ctx, publicUrl('download', '/data.bin'));
    assert.equal(download.status, 200);
    assert.deepEqual(download.bytes, file);
    const disposition = download.headers.get('content-disposition') ?? '';
    assert.ok(disposition.startsWith('attachment'), disposition);
    assert.ok(disposition.includes('data.bin'), disposition);

    // Range는 두 공개 경로 모두 206으로 지정 구간과 파일 ID·revision을 돌려준다.
    const ranges: Array<[string, number, number]> = [
      ['bytes=2-5', 2, 5],
      ['bytes=10-', 10, 99],
      ['bytes=-5', 95, 99],
    ];
    for (const route of ['content', 'download'] as const) {
      for (const [range, start, end] of ranges) {
        const label = `${route} ${range}`;
        const partial = await anonymousGet(ctx, publicUrl(route, '/data.bin'), { Range: range });
        assert.equal(partial.status, 206, label);
        assert.deepEqual(partial.bytes, file.subarray(start, end + 1), label);
        assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/100`, label);
        assert.equal(partial.headers.get('x-storix-file-id'), fileId, label);
        assert.equal(partial.headers.get('x-storix-revision'), revision, label);
      }
      // 처리할 수 없는 범위는 416이고 전체 길이를 알려 준다.
      const unsatisfiable = await anonymousGet(ctx, publicUrl(route, '/data.bin'), { Range: 'bytes=500-' });
      assert.equal(unsatisfiable.status, 416, route);
      assert.equal(unsatisfiable.json<{ code: string }>().code, 'VFS_RANGE_NOT_SATISFIABLE', route);
      assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */100', route);
    }

    // 파일을 교체하면 공개 경로도 새 바이트와 새 revision을 돌려준다.
    const replacement = Buffer.from('교체한 공개 내용', 'utf-8');
    const replaced = await ctx.client.putConditionalContent(ns, '/data.bin', replacement, {
      ifRevision: created.json<ConditionalResult>().resource.revision,
    });
    assert.equal(replaced.status, 200);
    const afterReplace = await anonymousGet(ctx, publicUrl('content', '/data.bin'), { Range: 'bytes=0-2' });
    assert.equal(afterReplace.status, 206);
    assert.deepEqual(afterReplace.bytes, replacement.subarray(0, 3));
    assert.equal(
      afterReplace.headers.get('x-storix-revision'),
      replaced.json<ConditionalResult>().resource.revision,
    );

    // 없는 파일은 404, 디렉터리는 409로 인증 경로와 같은 코드다.
    for (const route of ['content', 'download'] as const) {
      const missing = await anonymousGet(ctx, publicUrl(route, '/nope.bin'));
      assert.equal(missing.status, 404, route);
      assert.equal(missing.json<{ code: string }>().code, 'VFS_NODE_NOT_FOUND', route);
      const directory = await anonymousGet(ctx, publicUrl(route, '/dir'));
      assert.equal(directory.status, 409, route);
      assert.equal(directory.json<{ code: string }>().code, 'VFS_IS_DIRECTORY', route);
    }

    // 경로 계약은 공개 경로에도 같다. 상위 이동·상대 경로·경로 누락은 400 `VFS_INVALID_PATH`다.
    const badPaths = [
      publicUrl('content', '/../data.bin'),
      publicUrl('content', '/dir/../../data.bin'),
      publicUrl('content', 'data.bin'),
      publicUrl('download', '/../data.bin'),
      `/api/v2/public/${ns}/fs/content`,
    ];
    for (const url of badPaths) {
      const response = await anonymousGet(ctx, url);
      assert.equal(response.status, 400, url);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_PATH', url);
    }
  },
});
