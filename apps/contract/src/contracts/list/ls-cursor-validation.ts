// 소비자 기대: ls의 cursor가 서버가 만든 값이 아니면 서버 오류 없이 400 VFS_INVALID_CURSOR로 거부되고, 거부된 뒤에도 정상 cursor로 목록을 이어 읽을 수 있다.
// 대응 요구사항: RQ-022(디렉터리 자식 목록과 cursor 일관성). 형식이 잘못되거나 변조된 cursor는 400 VFS_INVALID_CURSOR다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Page {
  items: Array<{ name: string }>;
  nextCursor: string | null;
}

/** 서버가 만든 형식(`{name, id}` JSON의 base64url)을 흉내 낸 cursor를 만든다. 값만 잘못됐을 때의 거부를 확인하려는 용도다. */
function forgeCursor(position: { name: string; id: string }): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

export default defineContract({
  id: 'ls-cursor-validation',
  title:
    'UUID가 아닌 id나 NUL이 든 name을 담은 cursor와 중복 cursor는 400 VFS_INVALID_CURSOR로 거부되고 정상 cursor는 계속 쓸 수 있다',
  rq: ['RQ-022'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    assert.equal((await ctx.client.mkdir(ns, '/d')).status, 201);
    for (const name of ['a', 'b', 'c']) {
      const response = await ctx.client.putConditionalContent(ns, `/d/${name}.txt`, Buffer.from(name), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, name);
    }
    const first = await ctx.client.listDirectory(ns, '/d', { limit: 1 });
    assert.equal(first.status, 200, first.text());
    const firstPage = first.json<Page>();
    assert.ok(firstPage.nextCursor !== null);

    const forged = {
      'UUID가 아닌 id': forgeCursor({ name: 'a.txt', id: 'not-uuid' }),
      '빈 id': forgeCursor({ name: 'a.txt', id: '' }),
      'NUL이 든 name': forgeCursor({ name: 'a\u0000b', id: '11111111-1111-4111-8111-111111111111' }),
    };
    for (const [label, cursor] of Object.entries(forged)) {
      const response = await ctx.client.listDirectory(ns, '/d', { cursor });
      assert.equal(response.status, 400, `${label}: ${response.text()}`);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_CURSOR', label);
    }

    // 같은 파라미터를 여러 번 보내도 서버 오류가 아니라 cursor 오류다.
    const duplicated = await ctx.client.request(
      'GET',
      `/api/v2/namespaces/${ns}/fs/ls?path=%2Fd&cursor=a&cursor=b`,
    );
    assert.equal(duplicated.status, 400, duplicated.text());
    assert.equal(duplicated.json<{ code: string }>().code, 'VFS_INVALID_CURSOR');

    // 거부된 뒤에도 서버가 만든 cursor로 다음 페이지를 읽는다.
    const second = await ctx.client.listDirectory(ns, '/d', { limit: 1, cursor: firstPage.nextCursor });
    assert.equal(second.status, 200, second.text());
    assert.deepEqual(
      second.json<Page>().items.map((item) => item.name),
      ['b.txt'],
    );
  },
});
