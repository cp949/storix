// 소비자 기대: 한 번에 이동할 수 있는 노드 수를 넘는 디렉터리 이동은 한도 유형을 알 수 있는 오류로 거부되고, 원본과 하위 노드가 그대로 남는다.
// 상한은 `small-limits` 프로필이 5로 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'move-limit-rejection',
  title:
    '이동 노드 수 상한을 넘는 디렉터리 이동은 413 VFS_MOVE_LIMIT_EXCEEDED로 거부하고 아무것도 옮기지 않는다',
  rq: ['RQ-025', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const revisionOf = async (path: string): Promise<string> =>
      (await ctx.client.getStat(ns, path)).json<{ revision: string }>().revision;
    const move = async (source: string, destination: string) =>
      ctx.client.postMutation(ns, {
        kind: 'move',
        source,
        destination,
        sourceRevision: await revisionOf(source),
        destinationAbsent: true,
        destinationResolution: 'exact',
      });

    // 디렉터리 하나와 파일 여섯 개(노드 일곱 개)는 상한 5를 넘는다.
    assert.equal((await ctx.client.mkdir(ns, '/big')).status, 201);
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `/big/${name}.txt`);
    for (const path of files) {
      const response = await ctx.client.putConditionalContent(ns, path, Buffer.from(path), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, path);
    }

    const rejected = await move('/big', '/moved');
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_MOVE_LIMIT_EXCEEDED');
    // 목적지는 만들어지지 않고 원본 트리는 그대로다.
    assert.equal((await ctx.client.getStat(ns, '/moved')).status, 404);
    for (const path of ['/big', ...files]) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 200, `${path}가 남아 있어야 한다`);
    }

    // 상한 안의 작은 트리는 이동된다(상한이 이동 자체를 막지 않는다).
    assert.equal((await ctx.client.mkdir(ns, '/small')).status, 201);
    const child = await ctx.client.putConditionalContent(ns, '/small/x.txt', Buffer.from('x'), {
      ifAbsent: true,
    });
    assert.equal(child.status, 201);
    const moved = await move('/small', '/small-moved');
    assert.equal(moved.status, 200);
    assert.deepEqual((await ctx.client.getContent(ns, '/small-moved/x.txt')).bytes, Buffer.from('x'));
    assert.equal((await ctx.client.getStat(ns, '/small')).status, 404);

    // FILE 하나는 항상 한 노드이므로 상한과 무관하게 이동된다.
    assert.equal((await move(files[0], '/a-moved.txt')).status, 200);
  },
});
