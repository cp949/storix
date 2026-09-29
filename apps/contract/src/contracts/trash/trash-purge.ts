// 소비자 기대: 관리자만 휴지통 항목을 영구 삭제할 수 있고, purge는 그 항목의 바이트만 사용량에서 빼며 다른 파일과 snapshot의 바이트는 그대로 둔다. purge한 항목은 복구할 수 없다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제), RQ-017(저장량 회계).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Quota {
  usedBytes: string;
  trash: { retainedNodeCount: number };
}

export default defineContract({
  id: 'trash-purge',
  title:
    '휴지통 항목 purge는 관리자만 할 수 있고 그 항목의 바이트만 사용량에서 빼며 복구 불가이고 다른 파일·snapshot 바이트는 보존한다',
  rq: ['RQ-024', 'RQ-017'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const quotaOf = async (): Promise<Quota> =>
      (await ctx.client.getNamespace(ns)).json<{ quota: Quota }>().quota;
    const enabled = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text());

    // keep.txt와 gone.txt는 같은 바이트(6)이고, solo.txt(12바이트)는 snapshot을 하나 가진다.
    const shared = Buffer.from('shared');
    const unique = Buffer.from('unique-bytes');
    const stored = async (path: string, bytes: Buffer): Promise<{ id: string; revision: string }> => {
      const response = await ctx.client.putConditionalContent(ns, path, bytes, { ifAbsent: true });
      assert.equal(response.status, 201, path);
      return response.json<{ resource: { id: string; revision: string } }>().resource;
    };
    await stored('/keep.txt', shared);
    const gone = await stored('/gone.txt', shared);
    const solo = await stored('/solo.txt', unique);
    const snapshot = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/solo.txt' });
    assert.equal(snapshot.status, 201, snapshot.text());
    const snapshotId = snapshot.json<{ snapshotId: string }>().snapshotId;

    const trashed = async (path: string, revision: string): Promise<string> => {
      const response = await ctx.client.postMutation(ns, { kind: 'delete', path, ifRevision: revision });
      assert.equal(response.status, 200, response.text());
      return response.json<{ trashId: string }>().trashId;
    };
    const goneTrashId = await trashed('/gone.txt', gone.revision);
    const soloTrashId = await trashed('/solo.txt', solo.revision);
    // 사용량은 live 6+6+12에 snapshot 12를 더한 36이고, 휴지통으로 옮겨도 그대로다.
    const retained = await quotaOf();
    assert.equal(retained.usedBytes, '36');
    assert.equal(retained.trash.retainedNodeCount, 2);

    // 서비스 key로는 purge할 수 없고 항목이 그대로 남는다.
    const forbidden = await ctx.client.purgeTrash(ns, goneTrashId, ctx.apiKey);
    assert.equal(forbidden.status, 401);
    assert.equal((await quotaOf()).trash.retainedNodeCount, 2);
    assert.equal((await ctx.client.listTrash(ns)).json<{ items: unknown[] }>().items.length, 2);

    // 관리자 key로 purge하면 그 항목의 6바이트만 빠지고, 같은 바이트를 가진 live 파일은 그대로 읽힌다.
    const key = '3f0f8f3e-6d2a-4c0e-9d0b-5a5c1c1d7e21';
    const purged = await ctx.client.purgeTrash(ns, goneTrashId, ctx.adminKey, { idempotencyKey: key });
    assert.equal(purged.status, 200, purged.text());
    assert.deepEqual(purged.json(), { trashId: goneTrashId, purged: true });
    const afterFirst = await quotaOf();
    assert.equal(afterFirst.usedBytes, '30');
    assert.equal(afterFirst.trash.retainedNodeCount, 1);
    assert.deepEqual((await ctx.client.getContent(ns, '/keep.txt')).bytes, shared);

    // purge한 항목은 복구할 수 없고, 같은 key 재전송은 최초 응답을 그대로 받는다.
    const restore = await ctx.client.restoreTrash(ns, goneTrashId, {});
    assert.equal(restore.status, 404);
    assert.equal(restore.json<{ code: string }>().code, 'VFS_TRASH_ITEM_NOT_FOUND');
    const replay = await ctx.client.purgeTrash(ns, goneTrashId, ctx.adminKey, { idempotencyKey: key });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json(), purged.json());
    const missing = await ctx.client.purgeTrash(ns, goneTrashId, ctx.adminKey);
    assert.equal(missing.status, 404);
    assert.equal(missing.json<{ code: string }>().code, 'VFS_TRASH_ITEM_NOT_FOUND');
    assert.equal((await quotaOf()).usedBytes, '30');

    // snapshot을 가진 파일을 purge해도 snapshot 바이트는 사용량과 읽기에 남는다.
    const soloPurged = await ctx.client.purgeTrash(ns, soloTrashId, ctx.adminKey);
    assert.equal(soloPurged.status, 200, soloPurged.text());
    const final = await quotaOf();
    assert.equal(final.usedBytes, '18');
    assert.equal(final.trash.retainedNodeCount, 0);
    assert.deepEqual((await ctx.client.getSnapshotContent(ns, snapshotId)).bytes, unique);
    assert.deepEqual((await ctx.client.listTrash(ns)).json(), { items: [], nextCursor: null });
  },
});
