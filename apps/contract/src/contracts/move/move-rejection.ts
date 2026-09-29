// 소비자 기대: 이동이 거부되면(자기 subtree, 오래된 revision, 목적지 충돌, 없는 원본·부모, 잘못된 경로) 원본과 목적지 트리는 모두 그대로다.
// 대응 요구사항: RQ-025(파일·디렉터리 이동).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Stat {
  id: string;
  revision: string;
}

export default defineContract({
  id: 'move-rejection',
  title:
    '자기 subtree·오래된 revision·목적지 충돌·없는 원본과 부모·잘못된 경로 이동은 거부되고 트리를 바꾸지 않는다',
  rq: ['RQ-025'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const statOf = async (path: string): Promise<Stat> => {
      const response = await ctx.client.getStat(ns, path);
      assert.equal(response.status, 200, path);
      return response.json<Stat>();
    };
    const move = (source: string, destination: string, sourceRevision: string) =>
      ctx.client.postMutation(ns, {
        kind: 'move',
        source,
        destination,
        sourceRevision,
        destinationAbsent: true,
        destinationResolution: 'exact',
      });

    assert.equal((await ctx.client.mkdir(ns, '/tree')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/tree/inner')).status, 201);
    const mine = Buffer.from('옮길 파일', 'utf-8');
    const theirs = Buffer.from('이미 있는 파일', 'utf-8');
    assert.equal(
      (await ctx.client.putConditionalContent(ns, '/mine.txt', mine, { ifAbsent: true })).status,
      201,
    );
    assert.equal(
      (await ctx.client.putConditionalContent(ns, '/theirs.txt', theirs, { ifAbsent: true })).status,
      201,
    );
    const snapshotOf = async () => {
      const paths = ['/tree', '/tree/inner', '/mine.txt', '/theirs.txt'];
      return Promise.all(paths.map(async (path) => [path, await statOf(path)] as const));
    };
    const before = await snapshotOf();
    const unchanged = async () => {
      assert.deepEqual(await snapshotOf(), before);
      assert.deepEqual((await ctx.client.getContent(ns, '/mine.txt')).bytes, mine);
      assert.deepEqual((await ctx.client.getContent(ns, '/theirs.txt')).bytes, theirs);
    };
    const mineRevision = before.find(([path]) => path === '/mine.txt')![1].revision;
    const treeRevision = before.find(([path]) => path === '/tree')![1].revision;

    // 디렉터리를 자기 subtree로 옮길 수 없다.
    const intoSelf = await move('/tree', '/tree/inner/copy', treeRevision);
    assert.equal(intoSelf.status, 409);
    assert.equal(intoSelf.json<{ code: string }>().code, 'VFS_INVALID_OPERATION');
    await unchanged();

    // 실제로 있었던 revision이 오래된 값이 되도록 다른 파일을 한 번 교체한 뒤, 그 옛 revision으로 옮기려 하면 412다.
    const created = await ctx.client.putConditionalContent(ns, '/stale.txt', mine, { ifAbsent: true });
    const staleRevision = created.json<{ resource: { revision: string } }>().resource.revision;
    const replaced = await ctx.client.putConditionalContent(ns, '/stale.txt', theirs, {
      ifRevision: staleRevision,
    });
    assert.equal(replaced.status, 200);
    const stale = await move('/stale.txt', '/moved.txt', staleRevision);
    assert.equal(stale.status, 412);
    assert.equal((await ctx.client.getStat(ns, '/moved.txt')).status, 404);
    assert.deepEqual((await ctx.client.getContent(ns, '/stale.txt')).bytes, theirs);
    await unchanged();

    // exact 목적지가 이미 있으면 412이고 두 파일 모두 그대로다.
    const collision = await move('/mine.txt', '/theirs.txt', mineRevision);
    assert.equal(collision.status, 412);
    await unchanged();

    // 없는 원본은 404, 없는 목적지 부모는 404이며 부모가 만들어지지 않는다.
    assert.equal((await move('/absent.txt', '/x.txt', mineRevision)).status, 404);
    const noParent = await move('/mine.txt', '/nodir/mine.txt', mineRevision);
    assert.equal(noParent.status, 404);
    assert.equal((await ctx.client.getStat(ns, '/nodir')).status, 404);
    await unchanged();

    // 잘못된 목적지 경로는 400이다.
    const invalid = await move('/mine.txt', '/a/../b.txt', mineRevision);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json<{ code: string }>().code, 'VFS_INVALID_PATH');
    await unchanged();
  },
});
