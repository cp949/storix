// 소비자 기대: consistency=revision 목록의 cursor가 서버가 만든 값이 아니면 서버 오류 없이 400 VFS_INVALID_CURSOR로 거부되고, 거부된 뒤에도 정상 cursor로 목록을 이어 읽을 수 있다.
// 대응 요구사항: RQ-022(디렉터리 자식 목록과 cursor 일관성). 형식이 잘못되거나 변조된 cursor는 400 VFS_INVALID_CURSOR다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Page {
  items: Array<{ name: string }>;
  nextCursor: string | null;
}

export default defineContract({
  id: 'ls-revision-cursor-validation',
  title:
    'NUL이 든 name을 담은 revision 목록 cursor는 400 VFS_INVALID_CURSOR로 거부되고 정상 cursor는 계속 쓸 수 있다',
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
    const listing = (cursor?: string) =>
      ctx.client.request(
        'GET',
        `/api/v2/namespaces/${ns}/fs/ls?path=%2Fd&consistency=revision&limit=1${
          cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
        }`,
      );
    const first = await listing();
    assert.equal(first.status, 200, first.text());
    const firstPage = first.json<Page>();
    assert.ok(firstPage.nextCursor !== null);

    // 서버가 만든 cursor에서 name만 바꿔 directoryId·directoryRevision 검사를 통과하게 한다.
    const position = JSON.parse(
      Buffer.from(firstPage.nextCursor.slice(4), 'base64url').toString('utf8'),
    ) as Record<string, string>;
    const forged = `rc1.${Buffer.from(JSON.stringify({ ...position, name: 'a\u0000b' }), 'utf8').toString('base64url')}`;
    const rejected = await listing(forged);
    assert.equal(rejected.status, 400, rejected.text());
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_INVALID_CURSOR');

    // 거부된 뒤에도 서버가 만든 cursor로 다음 page를 읽는다.
    const second = await listing(firstPage.nextCursor);
    assert.equal(second.status, 200, second.text());
    assert.deepEqual(
      second.json<Page>().items.map((item) => item.name),
      ['b.txt'],
    );
  },
});
