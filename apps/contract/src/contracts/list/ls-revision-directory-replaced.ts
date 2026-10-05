// 소비자 기대: consistency=revision 열거 도중 같은 경로의 디렉터리가 삭제 뒤 다시 만들어져도 옛 cursor는 400이 아니라 412 VFS_PRECONDITION_FAILED로 거부되고, 첫 페이지부터 다시 열거하면 새 디렉터리 전체가 나온다.
// 대응 요구사항: RQ-022(디렉터리 자식 목록과 cursor 일관성). 디렉터리 변경 뒤 cursor 거부는 412 VFS_PRECONDITION_FAILED다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Page {
  items: Array<{ name: string }>;
  nextCursor: string | null;
}

export default defineContract({
  id: 'ls-revision-directory-replaced',
  title:
    'revision 열거 중 같은 경로의 디렉터리가 교체되면 옛 cursor는 412로 거부되고 재열거는 새 디렉터리를 돌려준다',
  rq: ['RQ-022'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const populate = async (names: string[]) => {
      assert.equal((await ctx.client.mkdir(ns, '/d')).status, 201);
      for (const name of names) {
        const response = await ctx.client.putConditionalContent(ns, `/d/${name}.txt`, Buffer.from(name), {
          ifAbsent: true,
        });
        assert.equal(response.status, 201, name);
      }
    };
    await populate(['a', 'b', 'c']);

    const first = await ctx.client.listDirectory(ns, '/d', { limit: 1, consistency: 'revision' });
    assert.equal(first.status, 200, first.text());
    const cursor = first.json<Page>().nextCursor;
    assert.ok(cursor !== null);

    // 같은 경로의 디렉터리를 지우고 다시 만든다. 디렉터리 id가 바뀐다.
    const removed = await ctx.client.remove(ns, '/d', true);
    assert.equal(removed.status, 204, removed.text());
    await populate(['x', 'y']);

    const stale = await ctx.client.listDirectory(ns, '/d', { limit: 1, consistency: 'revision', cursor });
    assert.equal(stale.status, 412, stale.text());
    assert.equal(stale.json<{ code: string }>().code, 'VFS_PRECONDITION_FAILED');

    // 첫 페이지부터 다시 열거하면 새 디렉터리의 자식만 나온다.
    const names: string[] = [];
    let next: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const response = await ctx.client.listDirectory(ns, '/d', {
        limit: 1,
        consistency: 'revision',
        cursor: next,
      });
      assert.equal(response.status, 200, response.text());
      const page = response.json<Page>();
      names.push(...page.items.map((item) => item.name));
      if (page.nextCursor === null) break;
      next = page.nextCursor;
    }
    assert.deepEqual(names.sort(), ['x.txt', 'y.txt']);
  },
});
