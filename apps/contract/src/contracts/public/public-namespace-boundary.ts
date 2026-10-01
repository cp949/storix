// 소비자 기대: 공개 경로는 PUBLIC namespace의 읽기만 인증 없이 열고, PRIVATE·없는 namespace는 구분되지 않는 404이며, 인증 경로와 변경은 PUBLIC namespace에서도 자격을 요구하고, namespace 삭제 뒤에는 공개 조회도 막힌다.
// 대응 요구사항: RQ-001(호출 서버 인증), RQ-002(namespace 격리), RQ-030(namespace 관리자 삭제).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse, ContractContext } from '../../define-contract.ts';

/** 자격 없이 요청한다. */
async function anonymous(
  ctx: ContractContext,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${ctx.baseUrl}${path}`, { signal: ctx.signal, method, ...init });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text: () => bytes.toString('utf-8'),
    json: <T = unknown>() => JSON.parse(bytes.toString('utf-8')) as T,
  };
}

const content = (ns: string, filePath = '/data.txt'): string =>
  `/api/v2/public/${ns}/fs/content?path=${encodeURIComponent(filePath)}`;

/** 오류 응답에서 요청마다 다른 값(`requestId`)과 namespace ID를 지워 비교한다. */
function shape(response: ApiResponse, namespaceId: string): unknown {
  const body = response.json<{ code: string; message: string }>();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    code: body.code,
    message: body.message.replaceAll(namespaceId, '<namespace>'),
  };
}

export default defineContract({
  id: 'public-namespace-boundary',
  title:
    '공개 경로는 PUBLIC namespace의 읽기만 인증 없이 열고, PRIVATE·없는 namespace는 같은 404이며, 인증 경로·변경은 자격을 요구하고, 삭제된 namespace는 공개 조회도 404다',
  rq: ['RQ-001', 'RQ-002', 'RQ-030'],
  async run(ctx) {
    const publicNs = (await ctx.createNamespace({ accessPolicy: 'PUBLIC' })).id;
    const privateNs = (await ctx.createNamespace()).id;
    const bytes = Buffer.from('공개 여부와 무관하게 저장한 내용', 'utf-8');
    for (const ns of [publicNs, privateNs]) {
      const stored = await ctx.client.putConditionalContent(ns, '/data.txt', bytes, { ifAbsent: true });
      assert.equal(stored.status, 201);
    }
    assert.equal(
      (await ctx.client.getNamespace(privateNs)).json<{ accessPolicy: string }>().accessPolicy,
      'PRIVATE',
    );

    // PUBLIC namespace의 파일은 자격 없이 읽힌다.
    const open = await anonymous(ctx, 'GET', content(publicNs));
    assert.equal(open.status, 200);
    assert.deepEqual(open.bytes, bytes);

    // PRIVATE·없는 namespace·UUID가 아닌 ID는 같은 404 NAMESPACE_NOT_FOUND라 존재 여부를 알 수 없다.
    const missingId = randomUUID();
    const hidden = await anonymous(ctx, 'GET', content(privateNs));
    assert.equal(hidden.status, 404);
    assert.equal(hidden.json<{ code: string }>().code, 'NAMESPACE_NOT_FOUND');
    assert.deepEqual(
      shape(hidden, privateNs),
      shape(await anonymous(ctx, 'GET', content(missingId)), missingId),
    );
    assert.deepEqual(
      shape(hidden, privateNs),
      shape(await anonymous(ctx, 'GET', content('not-a-uuid')), 'not-a-uuid'),
    );
    const hiddenDownload = await anonymous(
      ctx,
      'GET',
      `/api/v2/public/${privateNs}/fs/download?path=${encodeURIComponent('/data.txt')}`,
    );
    assert.equal(hiddenDownload.status, 404);
    assert.equal(hiddenDownload.json<{ code: string }>().code, 'NAMESPACE_NOT_FOUND');

    // 공개 경로는 읽기 두 route뿐이다. 목록·메타데이터·쓰기 route는 없다.
    const notExposed: Array<[string, string]> = [
      ['GET', `/api/v2/public/${publicNs}/fs/ls?path=/`],
      ['GET', `/api/v2/public/${publicNs}/fs/stat?path=/data.txt`],
      ['GET', `/api/v2/public/${publicNs}/fs/find?path=/`],
      ['POST', `/api/v2/public/${publicNs}/fs/content?path=/written.txt`],
      ['POST', `/api/v2/public/${publicNs}/fs/mkdir`],
    ];
    for (const [method, path] of notExposed) {
      const response = await anonymous(ctx, method, path, { body: method === 'POST' ? 'x' : undefined });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    assert.equal((await ctx.client.getStat(publicNs, '/written.txt')).status, 404);

    // 인증 경로는 PUBLIC namespace에서도 자격이 없으면 401이고, 변경은 적용되지 않는다.
    const fs = `/api/v2/namespaces/${publicNs}/fs`;
    const enc = encodeURIComponent('/data.txt');
    for (const path of [`${fs}/content?path=${enc}`, `${fs}/stat?path=${enc}`, `${fs}/ls?path=%2F`]) {
      const response = await anonymous(ctx, 'GET', path);
      assert.equal(response.status, 401, path);
      assert.equal(response.json<{ code: string }>().code, 'UNAUTHORIZED', path);
    }
    const mutationHeaders = { 'Idempotency-Key': randomUUID(), 'X-Mutation-Scope': 'anonymous' };
    const write = await anonymous(ctx, 'POST', `${fs}/content/conditional?path=%2Fanon.txt`, {
      headers: { ...mutationHeaders, 'X-If-Absent': 'true', 'Content-Type': 'application/octet-stream' },
      body: 'x',
    });
    assert.equal(write.status, 401);
    const remove = await anonymous(ctx, 'POST', `${fs}/rm?path=${enc}&recursive=false`, {
      headers: mutationHeaders,
    });
    assert.equal(remove.status, 401);
    const mkdir = await anonymous(ctx, 'POST', `${fs}/mkdir`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/anon-dir' }),
    });
    assert.equal(mkdir.status, 401);
    assert.equal((await ctx.client.getStat(publicNs, '/anon.txt')).status, 404);
    assert.equal((await ctx.client.getStat(publicNs, '/anon-dir')).status, 404);
    assert.deepEqual((await ctx.client.getContent(publicNs, '/data.txt')).bytes, bytes);

    // accessPolicy 입력 검증: 암호화와 함께 PUBLIC을 만들 수 없고, 알 수 없는 값은 거부한다. 거부된 namespace는 생기지 않는다.
    const create = async (body: object): Promise<ApiResponse> =>
      ctx.client.request('POST', '/api/v2/namespaces', {
        headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const conflict = await create({
      name: `public-conflict-${randomUUID().slice(0, 8)}`,
      accessPolicy: 'PUBLIC',
      encryptionPolicy: 'ENCRYPTED',
    });
    assert.equal(conflict.status, 400, conflict.text());
    assert.equal(conflict.json<{ code: string }>().code, 'NAMESPACE_PUBLIC_ENCRYPTION_CONFLICT');
    const invalid = await create({
      name: `public-invalid-${randomUUID().slice(0, 8)}`,
      accessPolicy: 'SECRET',
    });
    assert.equal(invalid.status, 400, invalid.text());
    assert.equal(invalid.json<{ code: string }>().code, 'NAMESPACE_INVALID_ACCESS_POLICY');

    // 삭제를 접수하면 인증 경로뿐 아니라 공개 경로도 404 NAMESPACE_NOT_FOUND로 막힌다. 다른 namespace는 그대로다.
    const deletion = await ctx.client.deleteNamespace(publicNs, ctx.adminKey);
    assert.equal(deletion.status, 202, deletion.text());
    const afterDelete = await anonymous(ctx, 'GET', content(publicNs));
    assert.equal(afterDelete.status, 404);
    assert.equal(afterDelete.json<{ code: string }>().code, 'NAMESPACE_NOT_FOUND');
    assert.deepEqual((await ctx.client.getContent(privateNs, '/data.txt')).bytes, bytes);
  },
});
