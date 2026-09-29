// 소비자 기대: 한 번에 지울 수 있는 노드 수를 넘는 재귀 삭제는 한도 유형을 알 수 있는 오류로 거부되고, 트리는 하나도 지워지지 않는다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제), RQ-018(안정적인 오류 분류). 상한은 `small-limits` 프로필이 5로 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'delete-limit-rejection',
  title: '삭제 노드 수 상한을 넘는 재귀 삭제는 413 VFS_DELETE_LIMIT_EXCEEDED로 거부하고 트리를 바꾸지 않는다',
  rq: ['RQ-024', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const revisionOf = async (path: string): Promise<string> =>
      (await ctx.client.getStat(ns, path)).json<{ revision: string }>().revision;

    // 디렉터리 하나와 파일 여섯 개(노드 일곱 개)는 상한 5를 넘는다.
    assert.equal((await ctx.client.mkdir(ns, '/big')).status, 201);
    const names = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `/big/${name}.txt`);
    for (const path of names) {
      const response = await ctx.client.putConditionalContent(ns, path, Buffer.from(path), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, path);
    }
    const revision = await revisionOf('/big');

    const rejected = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/big',
      ifRevision: revision,
      recursive: true,
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_DELETE_LIMIT_EXCEEDED');

    // 어떤 노드도 지워지지 않았고 디렉터리 revision도 그대로다.
    for (const path of ['/big', ...names]) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 200, `${path}가 남아 있어야 한다`);
    }
    assert.equal(await revisionOf('/big'), revision);

    // 상한 안의 작은 트리는 지워진다(상한이 삭제 자체를 막지 않는다).
    assert.equal((await ctx.client.mkdir(ns, '/small')).status, 201);
    const child = await ctx.client.putConditionalContent(ns, '/small/x.txt', Buffer.from('x'), {
      ifAbsent: true,
    });
    assert.equal(child.status, 201);
    const smallRevision = await revisionOf('/small');
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/small',
      ifRevision: smallRevision,
      recursive: true,
    });
    assert.equal(deleted.status, 200);
    assert.equal((await ctx.client.getStat(ns, '/small/x.txt')).status, 404);
  },
});
