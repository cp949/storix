// 소비자 기대: 복사가 거부되면(자기 subtree, 오래된 revision, 목적지 충돌, 없는 원본·부모, 잘못된 경로) 목적지에 부분 트리가 남지 않고 원본도 그대로다.
// 대응 요구사항: RQ-026(파일·디렉터리 복사).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Stat {
  id: string;
  revision: string;
}

export default defineContract({
  id: 'copy-rejection',
  title:
    '자기 subtree·오래된 revision·목적지 충돌·없는 원본과 부모·잘못된 경로 복사는 거부되고 부분 트리를 남기지 않는다',
  rq: ['RQ-026'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const statOf = async (path: string): Promise<Stat> => {
      const response = await ctx.client.getStat(ns, path);
      assert.equal(response.status, 200, path);
      return response.json<Stat>();
    };
    const rootNames = async (): Promise<string[]> =>
      (await ctx.client.listDirectory(ns, '/'))
        .json<{ items: Array<{ name: string }> }>()
        .items.map((item) => item.name)
        .sort();
    const copy = (source: string, destination: string, sourceRevision: string) =>
      ctx.client.postMutation(ns, {
        kind: 'copy',
        source,
        destination,
        sourceRevision,
        destinationAbsent: true,
        destinationResolution: 'exact',
      });

    assert.equal((await ctx.client.mkdir(ns, '/tree')).status, 201);
    const treeFile = await ctx.client.putConditionalContent(ns, '/tree/a.txt', Buffer.from('트리 파일'), {
      ifAbsent: true,
    });
    assert.equal(treeFile.status, 201);
    const mine = Buffer.from('복사할 파일', 'utf-8');
    const theirs = Buffer.from('이미 있는 파일', 'utf-8');
    assert.equal(
      (await ctx.client.putConditionalContent(ns, '/mine.txt', mine, { ifAbsent: true })).status,
      201,
    );
    assert.equal(
      (await ctx.client.putConditionalContent(ns, '/theirs.txt', theirs, { ifAbsent: true })).status,
      201,
    );
    const mineStat = await statOf('/mine.txt');
    const treeStat = await statOf('/tree');
    const namesBefore = await rootNames();
    const unchanged = async () => {
      assert.deepEqual(await rootNames(), namesBefore);
      assert.deepEqual(await statOf('/mine.txt'), mineStat);
      assert.deepEqual((await ctx.client.getContent(ns, '/theirs.txt')).bytes, theirs);
      assert.deepEqual(await statOf('/tree'), treeStat);
    };

    // 디렉터리를 자기 subtree로 복사할 수 없고, 하위에 부분 복사본이 남지 않는다.
    const intoSelf = await copy('/tree', '/tree/inner', treeStat.revision);
    assert.equal(intoSelf.status, 409);
    assert.equal(intoSelf.json<{ code: string }>().code, 'VFS_INVALID_OPERATION');
    assert.equal((await ctx.client.getStat(ns, '/tree/inner')).status, 404);
    await unchanged();

    // 실제로 있었던 revision이 오래된 값이 되도록 다른 파일을 한 번 교체한 뒤, 그 옛 revision으로 복사하면 412다.
    const created = await ctx.client.putConditionalContent(ns, '/stale.txt', mine, { ifAbsent: true });
    const staleRevision = created.json<{ resource: { revision: string } }>().resource.revision;
    const replaced = await ctx.client.putConditionalContent(ns, '/stale.txt', theirs, {
      ifRevision: staleRevision,
    });
    assert.equal(replaced.status, 200);
    const namesWithStale = await rootNames();
    const stale = await copy('/stale.txt', '/copied.txt', staleRevision);
    assert.equal(stale.status, 412);
    assert.equal((await ctx.client.getStat(ns, '/copied.txt')).status, 404);

    // exact 목적지가 이미 있으면 412이고 기존 파일이 그대로다.
    const collision = await copy('/mine.txt', '/theirs.txt', mineStat.revision);
    assert.equal(collision.status, 412);
    assert.deepEqual((await ctx.client.getContent(ns, '/theirs.txt')).bytes, theirs);

    // 없는 원본은 404, 없는 목적지 부모는 404이며 부모가 만들어지지 않는다.
    assert.equal((await copy('/absent.txt', '/x.txt', mineStat.revision)).status, 404);
    const noParent = await copy('/mine.txt', '/nodir/mine.txt', mineStat.revision);
    assert.equal(noParent.status, 404);
    assert.equal((await ctx.client.getStat(ns, '/nodir')).status, 404);

    // 잘못된 목적지 경로는 400이다.
    const invalid = await copy('/mine.txt', '/a/../b.txt', mineStat.revision);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json<{ code: string }>().code, 'VFS_INVALID_PATH');
    assert.deepEqual(await rootNames(), namesWithStale);
    assert.deepEqual(await statOf('/mine.txt'), mineStat);
  },
});
