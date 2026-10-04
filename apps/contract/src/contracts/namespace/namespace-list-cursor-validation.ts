// 소비자 기대: namespace 목록의 cursor가 서버가 만든 값이 아니면 서버 오류 없이 400 VFS_INVALID_CURSOR로 거부되고, 거부된 뒤에도 정상 cursor로 목록을 이어 읽을 수 있다.
// 대응 요구사항: RQ-031(Namespace ID와 선택 이름), RQ-018(안정적인 오류 분류). 형식이 잘못되거나 변조된 cursor는 400 VFS_INVALID_CURSOR다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Page {
  items: Array<{ id: string; name: string | null }>;
  nextCursor: string | null;
}

/** 서버가 만든 형식(`nl1.` 접두어와 `{name, id}` JSON의 base64url)을 흉내 낸 cursor를 만든다. 값만 잘못됐을 때의 거부를 확인하려는 용도다. */
function forgeCursor(position: { name: string; id: string }): string {
  return `nl1.${Buffer.from(JSON.stringify(position), 'utf8').toString('base64url')}`;
}

export default defineContract({
  id: 'namespace-list-cursor-validation',
  title:
    '서버가 만들 수 없는 name(NUL·대문자)을 담은 namespace 목록 cursor는 400 VFS_INVALID_CURSOR로 거부되고 정상 cursor는 계속 쓸 수 있다',
  rq: ['RQ-031', 'RQ-018'],
  async run(ctx) {
    // 활성 named namespace가 둘 이상이어야 limit=1 첫 page에 nextCursor가 생긴다.
    const first = await ctx.createNamespace();
    await ctx.createNamespace();

    const firstResponse = await ctx.client.request('GET', '/api/v2/namespaces?limit=1');
    assert.equal(firstResponse.status, 200, firstResponse.text());
    const firstPage = firstResponse.json<Page>();
    assert.ok(firstPage.nextCursor !== null);

    const forged = {
      'NUL이 든 name': forgeCursor({ name: 'a\u0000b', id: first.id }),
      '대문자가 든 name': forgeCursor({ name: 'Upper', id: first.id }),
    };
    for (const [label, cursor] of Object.entries(forged)) {
      const response = await ctx.client.request(
        'GET',
        `/api/v2/namespaces?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      assert.equal(response.status, 400, `${label}: ${response.text()}`);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_CURSOR', label);
    }

    // 거부된 뒤에도 서버가 만든 cursor로 다음 page를 읽는다.
    const second = await ctx.client.request(
      'GET',
      `/api/v2/namespaces?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    assert.equal(second.status, 200, second.text());
    assert.equal(second.json<Page>().items.length, 1);
  },
});
