// 소비자 기대: ls·stat·exists·find는 path를 생략하면 namespace root를 대상으로 하고, 빈 path는 상대경로처럼 거부된다.
// 대응 요구사항: RQ-003(경로 계약), RQ-022(디렉터리 자식 목록과 cursor 일관성). 규칙 출처는 openapi의 path 파라미터 설명.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

const ROUTES = ['ls', 'stat', 'exists', 'find'] as const;

export default defineContract({
  id: 'path-omitted-root',
  title: 'ls·stat·exists·find는 path 생략 시 root를 대상으로 하고 빈 path는 400 VFS_INVALID_PATH로 거부한다',
  rq: ['RQ-003', 'RQ-022'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    assert.equal((await ctx.client.mkdir(ns, '/a')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/a/b')).status, 201);
    const get = (route: string, query = '') =>
      ctx.client.request('GET', `/api/v2/namespaces/${ns}/fs/${route}${query}`);

    const listed = await get('ls');
    assert.equal(listed.status, 200, listed.text());
    assert.deepEqual(
      listed.json<{ items: Array<{ name: string }> }>().items.map((item) => item.name),
      ['a'],
    );

    const stat = await get('stat');
    assert.equal(stat.status, 200, stat.text());
    const root = stat.json<{ path: string; type: string }>();
    assert.equal(root.path, '/');
    assert.equal(root.type, 'DIRECTORY');

    const exists = await get('exists');
    assert.equal(exists.status, 200, exists.text());
    assert.deepEqual(exists.json<{ exists: boolean }>(), { exists: true });

    const found = await get('find');
    assert.equal(found.status, 200, found.text());
    assert.deepEqual(
      found
        .json<{ items: Array<{ path: string }> }>()
        .items.map((item) => item.path)
        .sort(),
      ['/a', '/a/b'],
    );

    // 생략과 달리 빈 문자열은 선행 `/`가 없는 경로다.
    for (const route of ROUTES) {
      const rejected = await get(route, '?path=');
      assert.equal(rejected.status, 400, `${route}: ${rejected.text()}`);
      assert.equal(rejected.json<{ code: string }>().code, 'VFS_INVALID_PATH', route);
    }
  },
});
