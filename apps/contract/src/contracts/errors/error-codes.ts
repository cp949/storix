// 소비자 기대: 호출 서버가 오류 메시지 문자열을 해석하지 않고 HTTP 상태와 `code`만으로 인증·부재·입력·충돌·조건 누락·key 재사용을 구분해 처리할 수 있다.
// 대응 요구사항: RQ-018(안정적인 오류 분류). 크기·저장량 한도 오류(413)는 `limits/` 계약이 다룬다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { revision: string };
}

interface ExpectedError {
  readonly name: string;
  readonly status: number;
  readonly code: string;
  readonly response: ApiResponse | Response;
}

export default defineContract({
  id: 'error-codes',
  title: '인증·부재·입력·유형·충돌·조건 누락·key 재사용 오류가 HTTP 상태와 안정적인 code로 구분된다',
  rq: ['RQ-018'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', Buffer.from('본문', 'utf-8'), {
      ifAbsent: true,
    });
    assert.equal(created.status, 201);
    const staleRevision = created.json<ConditionalResult>().resource.revision;
    // 실제로 있었던 revision이 오래된 값이 되도록 한 번 교체한다.
    const replaced = await ctx.client.putConditionalContent(
      ns,
      '/doc.txt',
      Buffer.from('교체된 본문', 'utf-8'),
      { ifRevision: staleRevision },
    );
    assert.equal(replaced.status, 200);
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    const missingId = randomUUID();

    // 같은 key를 다른 요청에 다시 쓰는 경우를 만든다.
    const reusedKey = randomUUID();
    const firstUse = await ctx.client.putConditionalContent(
      ns,
      '/reused.txt',
      Buffer.from('처음', 'utf-8'),
      {
        ifAbsent: true,
      },
      { idempotencyKey: reusedKey },
    );
    assert.equal(firstUse.status, 201);

    // 조건 헤더가 없는 조건부 저장과 Idempotency-Key가 없는 요청은 클라이언트로 표현할 수 없어 직접 보낸다.
    const conditionalUrl = (filePath: string) =>
      `/api/v2/namespaces/${ns}/fs/content/conditional?path=${encodeURIComponent(filePath)}`;
    const noCondition = await ctx.client.request('POST', conditionalUrl('/no-condition.txt'), {
      headers: {
        'Idempotency-Key': randomUUID(),
        'X-Mutation-Scope': 'storix-contract',
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from('조건 없음', 'utf-8'),
    });
    // namespace 생성은 Idempotency-Key가 필수다(openapi `createNamespace`).
    const noKey = await ctx.client.request('POST', '/api/v2/namespaces', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `error-codes-${randomUUID().slice(0, 8)}` }),
    });

    const cases: ExpectedError[] = [
      {
        name: '인증 실패',
        status: 401,
        code: 'UNAUTHORIZED',
        response: await fetch(`${ctx.baseUrl}/api/v2/namespaces/${ns}/fs/content?path=%2Fdoc.txt`, {
          signal: ctx.signal,
        }),
      },
      {
        name: 'namespace 없음',
        status: 404,
        code: 'NAMESPACE_NOT_FOUND',
        response: await ctx.client.getContent(missingId, '/doc.txt'),
      },
      {
        name: '경로 오류',
        status: 400,
        code: 'VFS_INVALID_PATH',
        response: await ctx.client.getContent(ns, '/dir/../doc.txt'),
      },
      {
        name: '파일 없음',
        status: 404,
        code: 'VFS_NODE_NOT_FOUND',
        response: await ctx.client.getContent(ns, '/absent.txt'),
      },
      {
        name: '디렉터리를 파일로 읽음',
        status: 409,
        code: 'VFS_IS_DIRECTORY',
        response: await ctx.client.getContent(ns, '/dir'),
      },
      {
        name: '파일 아래에 저장',
        status: 409,
        code: 'VFS_NOT_DIRECTORY',
        response: await ctx.client.putConditionalContent(
          ns,
          '/doc.txt/child.txt',
          Buffer.from('자식', 'utf-8'),
          { ifAbsent: true },
        ),
      },
      {
        name: 'revision 형식 오류',
        status: 400,
        code: 'VFS_INVALID_REVISION',
        response: await ctx.client.putConditionalContent(ns, '/doc.txt', Buffer.from('교체', 'utf-8'), {
          ifRevision: 'not-a-revision',
        }),
      },
      {
        name: 'revision 충돌',
        status: 412,
        code: 'VFS_PRECONDITION_FAILED',
        response: await ctx.client.putConditionalContent(ns, '/doc.txt', Buffer.from('교체', 'utf-8'), {
          ifRevision: staleRevision,
        }),
      },
      { name: '조건 누락', status: 428, code: 'VFS_PRECONDITION_REQUIRED', response: noCondition },
      {
        name: 'namespace 생성의 Idempotency-Key 누락',
        status: 400,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        response: noKey,
      },
      {
        name: 'key를 다른 요청에 재사용',
        status: 409,
        code: 'MUTATION_KEY_REUSED',
        response: await ctx.client.putConditionalContent(
          ns,
          '/reused.txt',
          Buffer.from('다른 본문', 'utf-8'),
          { ifAbsent: true },
          { idempotencyKey: reusedKey },
        ),
      },
      {
        name: 'snapshot 없음',
        status: 404,
        code: 'VFS_SNAPSHOT_NOT_FOUND',
        response: await ctx.client.getSnapshot(ns, missingId),
      },
    ];

    const seen = new Map<string, string>();
    for (const item of cases) {
      const body = await item.response.text();
      assert.equal(
        item.response.status,
        item.status,
        `${item.name}: 상태 ${item.response.status}, 본문 ${body}`,
      );
      const error = JSON.parse(body) as { code: string; message: string; requestId: string };
      assert.equal(error.code, item.code, `${item.name}: code`);
      assert.equal(typeof error.message, 'string', `${item.name}: message`);
      assert.ok(error.requestId.length > 0, `${item.name}: requestId가 있어야 한다`);
      // 같은 code가 서로 다른 경우에 재사용되면 코드만으로 구분할 수 없다.
      assert.equal(
        seen.get(error.code),
        undefined,
        `${item.name}: code ${error.code}가 ${seen.get(error.code)}와 겹친다`,
      );
      seen.set(error.code, item.name);
    }
  },
});
