// 소비자 기대: 조건부 삭제는 현재 revision과 일치할 때만 대상(재귀면 하위 전체)을 지우고, 거부되면 아무것도 바뀌지 않으며, 같은 경로를 다시 만들면 새 파일 ID를 받고 이미 만든 snapshot은 남는다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제). 휴지통은 기본 OFF인 namespace만 다룬다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'delete-conditional',
  title:
    '조건부 삭제는 revision이 맞을 때만 대상 전체를 지우고, 거부되면 무변경이며, 재생성한 파일은 새 ID를 받고 snapshot은 보존된다',
  rq: ['RQ-024'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const revisionOf = async (path: string): Promise<string> => {
      const stat = await ctx.client.getStat(ns, path);
      assert.equal(stat.status, 200, path);
      return stat.json<{ revision: string }>().revision;
    };
    const exists = async (path: string): Promise<boolean> =>
      (await ctx.client.getStat(ns, path)).status === 200;

    // 파일: snapshot을 만들고 한 번 교체해 첫 revision을 오래된 값으로 만든다.
    const first = Buffer.from('첫 내용', 'utf-8');
    const second = Buffer.from('교체한 내용', 'utf-8');
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', first, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;
    const snapshot = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.txt' });
    const snapshotId = snapshot.json<{ snapshotId: string }>().snapshotId;
    const replaced = await ctx.client.putConditionalContent(ns, '/doc.txt', second, {
      ifRevision: v1.revision,
    });
    const v2 = replaced.json<ConditionalResult>().resource;

    // 오래된 revision으로는 지워지지 않고, 충돌 응답이 현재 revision을 알려 준다.
    const stale = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/doc.txt',
      ifRevision: v1.revision,
    });
    assert.equal(stale.status, 412);
    assert.equal(stale.json<{ current: { revision: string } }>().current.revision, v2.revision);
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.txt')).bytes, second);

    // 현재 revision이면 지워진다. 휴지통이 꺼져 있으면 응답에 trashId가 없다.
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/doc.txt',
      ifRevision: v2.revision,
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json<{ trashId?: string }>().trashId, undefined);
    assert.equal((await ctx.client.getContent(ns, '/doc.txt')).status, 404);

    // 같은 경로를 다시 만들면 이전과 다른 파일 ID를 받고, snapshot은 삭제와 무관하게 읽힌다.
    const recreated = await ctx.client.putConditionalContent(ns, '/doc.txt', first, { ifAbsent: true });
    assert.equal(recreated.status, 201);
    assert.notEqual(recreated.json<ConditionalResult>().resource.id, v1.id);
    assert.equal((await ctx.client.getSnapshot(ns, snapshotId)).status, 200);
    assert.deepEqual((await ctx.client.getSnapshotContent(ns, snapshotId)).bytes, first);

    // 디렉터리: /dir 아래에 파일 하나와 하위 디렉터리(파일 하나 포함)를 만든다.
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/dir/sub')).status, 201);
    for (const path of ['/dir/a.txt', '/dir/sub/b.txt']) {
      const response = await ctx.client.putConditionalContent(ns, path, first, { ifAbsent: true });
      assert.equal(response.status, 201, path);
    }
    const oldDirRevision = await revisionOf('/dir');
    const extra = await ctx.client.putConditionalContent(ns, '/dir/c.txt', first, { ifAbsent: true });
    assert.equal(extra.status, 201);
    const dirRevision = await revisionOf('/dir');
    assert.notEqual(dirRevision, oldDirRevision);
    const tree = ['/dir', '/dir/a.txt', '/dir/c.txt', '/dir/sub', '/dir/sub/b.txt'];

    // 자식이 있는 디렉터리를 재귀 없이 지우면 409이고 트리가 그대로다.
    for (const body of [{}, { recursive: false }]) {
      const response = await ctx.client.postMutation(ns, {
        kind: 'delete',
        path: '/dir',
        ifRevision: dirRevision,
        ...body,
      });
      assert.equal(response.status, 409);
      assert.equal(response.json<{ code: string }>().code, 'VFS_DIRECTORY_NOT_EMPTY');
    }
    // 오래된 디렉터리 revision으로 재귀 삭제해도 412이고 트리가 그대로다.
    const staleDir = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/dir',
      ifRevision: oldDirRevision,
      recursive: true,
    });
    assert.equal(staleDir.status, 412);
    for (const path of tree) assert.ok(await exists(path), `${path}가 남아 있어야 한다`);
    assert.equal(await revisionOf('/dir'), dirRevision);

    // 현재 revision으로 재귀 삭제하면 하위 전체가 한 번에 사라진다.
    const recursive = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/dir',
      ifRevision: dirRevision,
      recursive: true,
    });
    assert.equal(recursive.status, 200);
    for (const path of tree) assert.ok(!(await exists(path)), `${path}가 사라져야 한다`);
  },
});
