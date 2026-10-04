// 소비자 기대: find의 cursor와 name이 유효하지 않으면 서버 오류 없이 400으로 거부되고, 유효한 검색은 그대로 동작한다.
// 대응 요구사항: RQ-018(안정적인 오류 분류). cursor 오류는 400 VFS_INVALID_CURSOR, name 오류는 400 VFS_INVALID_QUERY다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

/** 서버가 만든 형식(`{name, id}` JSON의 base64url)을 흉내 낸 cursor를 만든다. 값만 잘못됐을 때의 거부를 확인하려는 용도다. */
function forgeCursor(position: { name: string; id: string }): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

export default defineContract({
  id: 'find-input-validation',
  title:
    'find는 유효하지 않은 cursor를 400 VFS_INVALID_CURSOR로, 중복되거나 NUL이 든 name을 400 VFS_INVALID_QUERY로 거부한다',
  rq: ['RQ-018'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const base = `/api/v2/namespaces/${ns}/fs/find?path=%2F`;
    assert.equal((await ctx.client.mkdir(ns, '/report-2026')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/notes')).status, 201);

    const codeOf = async (query: string, status: number, label: string): Promise<string> => {
      const response = await ctx.client.request('GET', `${base}&${query}`);
      assert.equal(response.status, status, `${label}: ${response.text()}`);
      return response.json<{ code: string }>().code;
    };

    // cursor: UUID가 아닌 id, NUL이 든 name, 중복 파라미터.
    const cursors = {
      'UUID가 아닌 id': forgeCursor({ name: 'a', id: 'not-uuid' }),
      'NUL이 든 name': forgeCursor({ name: 'a\u0000b', id: '11111111-1111-4111-8111-111111111111' }),
    };
    for (const [label, cursor] of Object.entries(cursors)) {
      assert.equal(await codeOf(`cursor=${cursor}`, 400, label), 'VFS_INVALID_CURSOR', label);
    }
    assert.equal(await codeOf('cursor=a&cursor=b', 400, '중복 cursor'), 'VFS_INVALID_CURSOR');

    // name: match 값과 관계없이 중복 파라미터와 NUL을 거부한다.
    for (const match of ['contains', 'exact', 'prefix', 'suffix']) {
      assert.equal(
        await codeOf(`name=a&name=b&match=${match}`, 400, `중복 name ${match}`),
        'VFS_INVALID_QUERY',
        `중복 name ${match}`,
      );
      assert.equal(
        await codeOf(`name=a%00b&match=${match}`, 400, `NUL name ${match}`),
        'VFS_INVALID_QUERY',
        `NUL name ${match}`,
      );
    }
    assert.equal(await codeOf('name=a&name=b', 400, 'match 생략 중복 name'), 'VFS_INVALID_QUERY');

    // 거부된 뒤에도 유효한 검색은 그대로 동작하고, 빈 name은 필터 없음이다.
    const filtered = await ctx.client.request('GET', `${base}&name=report&match=contains`);
    assert.equal(filtered.status, 200, filtered.text());
    assert.deepEqual(
      filtered.json<{ items: Array<{ name: string }> }>().items.map((item) => item.name),
      ['report-2026'],
    );
    const unfiltered = await ctx.client.request('GET', `${base}&name=`);
    assert.equal(unfiltered.status, 200, unfiltered.text());
    assert.equal(unfiltered.json<{ items: unknown[] }>().items.length, 2);
  },
});
