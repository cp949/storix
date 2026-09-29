// 소비자 기대: 한 번에 복사할 수 있는 노드 수를 넘는 복사는 한도 유형을 알 수 있는 오류로 거부되고, 목적지에 부분 트리가 남지 않는다.
// 대응 요구사항: RQ-026(파일·디렉터리 복사), RQ-018(안정적인 오류 분류). 상한은 `small-limits` 프로필이 5로 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'copy-limit-rejection',
  title: '복사 노드 수 상한을 넘는 복사는 413 VFS_COPY_LIMIT_EXCEEDED로 거부하고 부분 트리를 남기지 않는다',
  rq: ['RQ-026', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const revisionOf = async (path: string): Promise<string> =>
      (await ctx.client.getStat(ns, path)).json<{ revision: string }>().revision;
    const copy = async (source: string, destination: string) =>
      ctx.client.postMutation(ns, {
        kind: 'copy',
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

    const rejected = await copy('/big', '/big-copy');
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_COPY_LIMIT_EXCEEDED');
    // 목적지 루트도, 그 아래 노드도 만들어지지 않고 원본은 그대로다.
    assert.equal((await ctx.client.getStat(ns, '/big-copy')).status, 404);
    for (const path of ['/big', ...files]) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 200, `${path}가 남아 있어야 한다`);
    }

    // 상한 안의 작은 트리는 복사된다(상한이 복사 자체를 막지 않는다).
    assert.equal((await ctx.client.mkdir(ns, '/small')).status, 201);
    const child = await ctx.client.putConditionalContent(ns, '/small/x.txt', Buffer.from('x'), {
      ifAbsent: true,
    });
    assert.equal(child.status, 201);
    const copied = await copy('/small', '/small-copy');
    assert.equal(copied.status, 201);
    assert.deepEqual((await ctx.client.getContent(ns, '/small-copy/x.txt')).bytes, Buffer.from('x'));
  },
});
