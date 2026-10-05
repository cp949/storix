// 소비자 기대: rm과 조건부 delete는 recursive 없이 빈 디렉터리만 지우고, 비어 있지 않은 디렉터리는 트리를 바꾸지 않고 409 VFS_DIRECTORY_NOT_EMPTY로 거부한다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'rm-directory-requires-recursive',
  title:
    'rm·조건부 delete는 recursive 없이 빈 디렉터리만 지우고 비어 있지 않으면 409 VFS_DIRECTORY_NOT_EMPTY다',
  rq: ['RQ-018', 'RQ-024'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    for (const path of ['/rm', '/rm/child', '/mutation', '/mutation/child']) {
      assert.equal((await ctx.client.mkdir(ns, path)).status, 201, path);
    }
    const exists = async (path: string): Promise<boolean> =>
      (await ctx.client.getStat(ns, path)).status === 200;
    const revisionOf = async (path: string): Promise<string> =>
      (await ctx.client.getStat(ns, path)).json<{ revision: string }>().revision;
    const deleteByMutation = async (path: string) =>
      ctx.client.postMutation(ns, { kind: 'delete', path, ifRevision: await revisionOf(path) });

    // 비어 있지 않은 디렉터리는 거부하고 하위 트리를 그대로 둔다.
    const rmNonEmpty = await ctx.client.remove(ns, '/rm');
    assert.equal(rmNonEmpty.status, 409, rmNonEmpty.text());
    assert.equal(rmNonEmpty.json<{ code: string }>().code, 'VFS_DIRECTORY_NOT_EMPTY');
    const mutationNonEmpty = await deleteByMutation('/mutation');
    assert.equal(mutationNonEmpty.status, 409, mutationNonEmpty.text());
    assert.equal(mutationNonEmpty.json<{ code: string }>().code, 'VFS_DIRECTORY_NOT_EMPTY');
    assert.ok((await exists('/rm/child')) && (await exists('/mutation/child')));

    // 빈 디렉터리는 recursive 없이 지운다.
    const rmEmpty = await ctx.client.remove(ns, '/rm/child');
    assert.equal(rmEmpty.status, 204, rmEmpty.text());
    const mutationEmpty = await deleteByMutation('/mutation/child');
    assert.equal(mutationEmpty.status, 200, mutationEmpty.text());
    assert.ok(!(await exists('/rm/child')) && !(await exists('/mutation/child')));
  },
});
