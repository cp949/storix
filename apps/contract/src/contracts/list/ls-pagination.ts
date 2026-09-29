// 소비자 기대: 디렉터리 자식은 cursor 페이지로 누락·중복 없이 열거되고, consistency=revision 열거는 한 디렉터리 revision에 묶이며, 열거 도중 디렉터리가 바뀌면 다음 페이지를 이어 붙이지 않고 거부한다.
// 대응 요구사항: RQ-022(디렉터리 자식 목록과 cursor 일관성). 디렉터리 변경 뒤 cursor 거부는 412 VFS_PRECONDITION_FAILED다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';
import type { ApiClient } from '../../define-contract.ts';

interface Page {
  items: Array<{ name: string }>;
  nextCursor: string | null;
  directoryRevision?: string;
}

/** 첫 페이지부터 nextCursor가 null이 될 때까지 읽어 페이지 목록을 돌려준다. */
async function readAllPages(
  client: ApiClient,
  ns: string,
  dirPath: string,
  consistency?: 'revision',
): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const response = await client.listDirectory(ns, dirPath, { limit: 3, cursor, consistency });
    assert.equal(response.status, 200, response.text());
    const page = response.json<Page>();
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error('페이지가 끝나지 않는다');
}

export default defineContract({
  id: 'ls-pagination',
  title:
    '자식 목록은 페이지로 누락·중복 없이 열거되고, revision 열거는 디렉터리 변경 뒤 다음 페이지를 거부한다',
  rq: ['RQ-022'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    assert.equal((await ctx.client.mkdir(ns, '/d')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/d/folder')).status, 201);
    const expected = ['folder'];
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const response = await ctx.client.putConditionalContent(ns, `/d/${name}.txt`, Buffer.from(name), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, name);
      expected.push(`${name}.txt`);
    }
    expected.sort();

    // 기본 열거: 페이지 크기를 지키고 모든 자식이 한 번씩 나온다.
    const plain = await readAllPages(ctx.client, ns, '/d');
    assert.ok(plain.length > 1, '한 페이지에 다 담기면 페이지 검증이 되지 않는다');
    for (const page of plain) assert.ok(page.items.length <= 3);
    const plainNames = plain.flatMap((page) => page.items.map((item) => item.name));
    assert.deepEqual([...plainNames].sort(), expected);

    // revision 열거: 모든 페이지가 같은 directoryRevision을 알리고 그 값이 현재 디렉터리 revision이다.
    const dirRevision = (await ctx.client.getStat(ns, '/d')).json<{ revision: string }>().revision;
    const bound = await readAllPages(ctx.client, ns, '/d', 'revision');
    assert.ok(bound.length > 1);
    for (const page of bound) assert.equal(page.directoryRevision, dirRevision);
    assert.deepEqual(bound.flatMap((page) => page.items.map((item) => item.name)).sort(), expected);

    // 첫 페이지를 읽은 뒤 디렉터리를 바꾸면, 그 cursor로 다음 페이지를 이어 붙이지 않고 거부한다.
    const first = await ctx.client.listDirectory(ns, '/d', {
      limit: 3,
      consistency: 'revision',
    });
    const cursor = first.json<Page>().nextCursor;
    assert.ok(cursor !== null);
    const added = await ctx.client.putConditionalContent(ns, '/d/g.txt', Buffer.from('g'), {
      ifAbsent: true,
    });
    assert.equal(added.status, 201);
    const stale = await ctx.client.listDirectory(ns, '/d', {
      limit: 3,
      consistency: 'revision',
      cursor,
    });
    assert.equal(stale.status, 412, stale.text());
    assert.equal(stale.json<{ code: string }>().code, 'VFS_PRECONDITION_FAILED');

    // 첫 페이지부터 다시 열거하면 새 상태 전체가 나온다.
    const restarted = await readAllPages(ctx.client, ns, '/d', 'revision');
    assert.deepEqual(
      restarted.flatMap((page) => page.items.map((item) => item.name)).sort(),
      [...expected, 'g.txt'].sort(),
    );

    // 형식이 잘못된 cursor는 400 VFS_INVALID_CURSOR다.
    for (const [badCursor, consistency] of [
      ['garbage', undefined],
      ['rc1.garbage', 'revision'],
    ] as const) {
      const response = await ctx.client.listDirectory(ns, '/d', {
        limit: 3,
        cursor: badCursor,
        consistency,
      });
      assert.equal(response.status, 400, badCursor);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_CURSOR', badCursor);
    }
  },
});
