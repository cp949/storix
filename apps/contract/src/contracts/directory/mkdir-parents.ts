// 소비자 기대: 부모 디렉터리는 명시할 때만 만들어지고, 조건부 mkdir은 대상이 이미 있으면 거부하며, 이미 있는 디렉터리를 parents로 다시 요청해도 ID와 상태가 그대로이고 parents 없이 다시 요청하면 거부한다.
// 대응 요구사항: RQ-023(디렉터리 생성). parents 없이 기존 디렉터리를 다시 만드는 요청은 409 VFS_ALREADY_EXISTS다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Node {
  id: string;
  path: string;
  type: string;
  version: number;
}

export default defineContract({
  id: 'mkdir-parents',
  title:
    '부모 디렉터리는 parents를 명시할 때만 만들고, 조건부 mkdir은 기존 대상을 거부하며, 기존 디렉터리의 parents 재요청은 ID를 보존하고 parents 없는 재요청은 거부한다',
  rq: ['RQ-023'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    // parents를 생략하거나 false로 두면 없는 부모를 암묵적으로 만들지 않는다.
    for (const parents of [undefined, false] as const) {
      const response = await ctx.client.mkdir(ns, '/missing/child', parents);
      assert.equal(response.status, 404);
      assert.equal(response.json<{ code: string }>().code, 'VFS_NODE_NOT_FOUND');
      assert.equal((await ctx.client.getStat(ns, '/missing')).status, 404);
    }

    // parents=true이면 부모와 대상이 함께 만들어진다.
    const created = await ctx.client.mkdir(ns, '/a/b/c', true);
    assert.equal(created.status, 201);
    const node = created.json<Node>();
    assert.equal(node.type, 'DIRECTORY');
    assert.equal(node.path, '/a/b/c');
    for (const dir of ['/a', '/a/b', '/a/b/c']) {
      assert.equal((await ctx.client.getStat(ns, dir)).status, 200, dir);
    }

    // 이미 있는 디렉터리를 다시 요청하면 같은 ID와 상태를 돌려주고 아무것도 바꾸지 않는다.
    const again = await ctx.client.mkdir(ns, '/a/b/c', true);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json<Node>(), node);

    // parents를 생략하거나 false로 두면 같은 요청도 409 VFS_ALREADY_EXISTS로 거부하고 상태를 바꾸지 않는다.
    for (const parents of [undefined, false] as const) {
      const rejected = await ctx.client.mkdir(ns, '/a/b/c', parents);
      assert.equal(rejected.status, 409, String(parents));
      assert.equal(rejected.json<{ code: string }>().code, 'VFS_ALREADY_EXISTS');
      const stat = (await ctx.client.getStat(ns, '/a/b/c')).json<Node>();
      assert.equal(stat.id, node.id);
      assert.equal(stat.version, node.version);
    }

    // 경로 중간이 파일이면 parents=true여도 거부되고 아무것도 생기지 않는다.
    const file = await ctx.client.putConditionalContent(ns, '/a/file.txt', Buffer.from('파일', 'utf-8'), {
      ifAbsent: true,
    });
    assert.equal(file.status, 201);
    const throughFile = await ctx.client.mkdir(ns, '/a/file.txt/sub/deeper', true);
    assert.equal(throughFile.status, 409);
    assert.equal(throughFile.json<{ code: string }>().code, 'VFS_NOT_DIRECTORY');
    const listed = await ctx.client.listDirectory(ns, '/a');
    assert.deepEqual(
      listed
        .json<{ items: Array<{ name: string }> }>()
        .items.map((item) => item.name)
        .sort(),
      ['b', 'file.txt'],
    );

    // 조건부 mkdir: 부재 조건으로 만들고, 이미 있으면 412, 부모가 없으면 404이며 만들지 않는다.
    const conditional = await ctx.client.postMutation(ns, { kind: 'mkdir', path: '/m', ifAbsent: true });
    assert.equal(conditional.status, 201);
    const existing = await ctx.client.postMutation(ns, { kind: 'mkdir', path: '/m', ifAbsent: true });
    assert.equal(existing.status, 412);
    assert.equal(existing.json<{ code: string }>().code, 'VFS_PRECONDITION_FAILED');
    const orphan = await ctx.client.postMutation(ns, { kind: 'mkdir', path: '/n/o', ifAbsent: true });
    assert.equal(orphan.status, 404);
    assert.equal((await ctx.client.getStat(ns, '/n')).status, 404);
  },
});
