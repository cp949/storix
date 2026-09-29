// 소비자 기대: 휴지통이 보존하는 노드 수 상한을 넘는 삭제는 한도 유형을 알 수 있는 오류로 거부되고 아무것도 지워지지 않으며, 기존 항목을 밀어내지 않는다. purge로 자리가 나면 삭제된다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제), RQ-018(안정적인 오류 분류). 상한은 `small-limits` 프로필이 3으로 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Quota {
  usedBytes: string;
  trash: { retainedNodeCount: number; maxRetainedNodes: number };
}

export default defineContract({
  id: 'trash-retention-limit',
  title:
    '휴지통 보존 노드 상한을 넘는 삭제는 413 VFS_TRASH_LIMIT_EXCEEDED로 거부하고 무변경이며 기존 항목을 밀어내지 않는다',
  rq: ['RQ-024', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const quotaOf = async (): Promise<Quota> =>
      (await ctx.client.getNamespace(ns)).json<{ quota: Quota }>().quota;
    const enabled = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text());
    assert.equal((await quotaOf()).trash.maxRetainedNodes, 3);

    const revisionOf = async (path: string): Promise<string> =>
      (await ctx.client.getStat(ns, path)).json<{ revision: string }>().revision;
    const store = async (path: string): Promise<void> => {
      const response = await ctx.client.putConditionalContent(ns, path, Buffer.from(path), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, path);
    };
    const remove = (path: string, revision: string, recursive = false) =>
      ctx.client.postMutation(ns, { kind: 'delete', path, ifRevision: revision, recursive });

    // 노드 네 개(디렉터리 하나와 파일 셋)의 트리는 상한 3을 넘어 거부되고 트리가 그대로다.
    assert.equal((await ctx.client.mkdir(ns, '/tree')).status, 201);
    for (const name of ['x', 'y', 'z']) await store(`/tree/${name}.txt`);
    const treeRevision = await revisionOf('/tree');
    const tooBig = await remove('/tree', treeRevision, true);
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json<{ code: string }>().code, 'VFS_TRASH_LIMIT_EXCEEDED');
    for (const path of ['/tree', '/tree/x.txt', '/tree/y.txt', '/tree/z.txt']) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 200, `${path}가 남아 있어야 한다`);
    }
    assert.equal(await revisionOf('/tree'), treeRevision);
    const untouched = await quotaOf();
    assert.equal(untouched.trash.retainedNodeCount, 0);
    assert.equal((await ctx.client.listTrash(ns)).json<{ items: unknown[] }>().items.length, 0);

    // 파일 셋은 상한까지 보존되고, 네 번째 파일 삭제는 거부되며 앞 항목을 밀어내지 않는다.
    const trashIds: string[] = [];
    for (const name of ['f1', 'f2', 'f3']) {
      await store(`/${name}.txt`);
      const deleted = await remove(`/${name}.txt`, await revisionOf(`/${name}.txt`));
      assert.equal(deleted.status, 200, deleted.text());
      trashIds.push(deleted.json<{ trashId: string }>().trashId);
    }
    assert.equal((await quotaOf()).trash.retainedNodeCount, 3);
    await store('/f4.txt');
    const f4Revision = await revisionOf('/f4.txt');
    const rejected = await remove('/f4.txt', f4Revision);
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_TRASH_LIMIT_EXCEEDED');
    assert.equal(await revisionOf('/f4.txt'), f4Revision);
    const listed = (await ctx.client.listTrash(ns)).json<{ items: { trashId: string }[] }>().items;
    assert.deepEqual(listed.map((item) => item.trashId).sort(), [...trashIds].sort());
    assert.equal((await quotaOf()).trash.retainedNodeCount, 3);

    // 항목 하나를 purge해 자리가 나면 같은 삭제가 성공한다.
    const purged = await ctx.client.purgeTrash(ns, trashIds[0], ctx.adminKey);
    assert.equal(purged.status, 200, purged.text());
    const retried = await remove('/f4.txt', f4Revision);
    assert.equal(retried.status, 200, retried.text());
    assert.equal((await quotaOf()).trash.retainedNodeCount, 3);
  },
});
