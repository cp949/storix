// 소비자 기대: 휴지통이 켜진 namespace의 삭제는 subtree를 하나의 휴지통 항목으로 보존하고, 복구는 원래 node ID와 새 revision으로 되살리며, 충돌하면 아무것도 바꾸지 않는다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제). 정책이 꺼진 삭제는 `delete-conditional`이 다룬다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';
import type { ContractContext } from '../../define-contract.ts';

interface Quota {
  usedBytes: string;
  trash: { enabled: boolean; retainedNodeCount: number };
}

interface TrashItem {
  trashId: string;
  originalPath: string;
  rootType: string;
  nodeCount: number;
  logicalBytes: string;
}

interface Stat {
  id: string;
  revision: string;
}

export default defineContract({
  id: 'trash-delete-restore',
  title:
    '휴지통이 켜진 삭제는 subtree를 항목 하나로 보존하고 복구는 원래 node ID로 되살리며 충돌하면 무변경이다',
  rq: ['RQ-024'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const quotaOf = async (): Promise<Quota> =>
      (await ctx.client.getNamespace(ns)).json<{ quota: Quota }>().quota;
    const statOf = async (path: string): Promise<Stat> => {
      const stat = await ctx.client.getStat(ns, path);
      assert.equal(stat.status, 200, path);
      return stat.json<Stat>();
    };
    const listItems = async (): Promise<TrashItem[]> => {
      const page = await ctx.client.listTrash(ns);
      assert.equal(page.status, 200, page.text());
      return page.json<{ items: TrashItem[] }>().items;
    };

    const enabled = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text());
    assert.equal((await quotaOf()).trash.enabled, true);

    // /dir에 디렉터리 하나와 파일 둘(4+6바이트)을 만든다. 노드는 모두 네 개다.
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/dir/sub')).status, 201);
    const contents: Record<string, Buffer> = {
      '/dir/a.txt': Buffer.from('aaaa'),
      '/dir/sub/b.txt': Buffer.from('bbbbbb'),
    };
    for (const [path, bytes] of Object.entries(contents)) {
      const stored = await ctx.client.putConditionalContent(ns, path, bytes, { ifAbsent: true });
      assert.equal(stored.status, 201, path);
    }
    const ids = {
      dir: (await statOf('/dir')).id,
      sub: (await statOf('/dir/sub')).id,
      a: (await statOf('/dir/a.txt')).id,
      b: (await statOf('/dir/sub/b.txt')).id,
    };
    const oldRevision = (await statOf('/dir')).revision;

    // 재귀 삭제는 trashId를 알려 주고 live 경로를 비우지만, 바이트는 휴지통이 만료·purge 전까지 논리 사용량에 남긴다.
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/dir',
      ifRevision: oldRevision,
      recursive: true,
    });
    assert.equal(deleted.status, 200, deleted.text());
    const trashId = deleted.json<{ trashId: string }>().trashId;
    assert.match(trashId, /^[0-9a-f-]{36}$/);
    for (const path of ['/dir', '/dir/sub', '/dir/a.txt', '/dir/sub/b.txt']) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 404, `${path}가 비어야 한다`);
    }
    const retained = await quotaOf();
    assert.equal(retained.usedBytes, '10');
    assert.equal(retained.trash.retainedNodeCount, 4);
    const items = await listItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].trashId, trashId);
    assert.equal(items[0].originalPath, '/dir');
    assert.equal(items[0].rootType, 'DIRECTORY');
    assert.equal(items[0].nodeCount, 4);
    assert.equal(items[0].logicalBytes, '10');

    // 원래 경로에 새로 만든 디렉터리가 있으면 412로 거절하고 덮어쓰지 않으며 항목이 그대로 남는다.
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    const occupied = await statOf('/dir');
    const conflict = await ctx.client.restoreTrash(ns, trashId, {});
    assert.equal(conflict.status, 412);
    assert.equal(conflict.json<{ code: string }>().code, 'VFS_PRECONDITION_FAILED');
    assert.deepEqual(await statOf('/dir'), occupied);
    assert.equal((await ctx.client.getStat(ns, '/dir/a.txt')).status, 404);
    // 대상 부모가 없어도 거절하고, 부모를 자동으로 만들지 않는다.
    const orphan = await ctx.client.restoreTrash(ns, trashId, { targetPath: '/missing/back' });
    assert.equal(orphan.status, 404);
    assert.equal((await ctx.client.getStat(ns, '/missing')).status, 404);
    assert.deepEqual(
      (await listItems()).map((item) => item.trashId),
      [trashId],
    );
    assert.equal((await quotaOf()).usedBytes, '10');

    // 다른 경로로 복구하면 subtree 전체가 원래 node ID와 본문으로 돌아오고 revision은 새로 발급된다.
    const key = 'b6f5c4c8-9d1a-4a7e-8f3e-2b1d0c6a9e10';
    const restored = await ctx.client.restoreTrash(
      ns,
      trashId,
      { targetPath: '/back' },
      { idempotencyKey: key },
    );
    assert.equal(restored.status, 200, restored.text());
    const resource = restored.json<{
      trashId: string;
      resource: { id: string; path: string; revision: string };
    }>();
    assert.equal(resource.trashId, trashId);
    assert.equal(resource.resource.path, '/back');
    assert.equal(resource.resource.id, ids.dir);
    assert.notEqual(resource.resource.revision, oldRevision);
    assert.equal((await statOf('/back/sub')).id, ids.sub);
    assert.equal((await statOf('/back/a.txt')).id, ids.a);
    assert.equal((await statOf('/back/sub/b.txt')).id, ids.b);
    assert.deepEqual((await ctx.client.getContent(ns, '/back/a.txt')).bytes, contents['/dir/a.txt']);
    assert.deepEqual((await ctx.client.getContent(ns, '/back/sub/b.txt')).bytes, contents['/dir/sub/b.txt']);
    assert.deepEqual(await listItems(), []);
    const restoredQuota = await quotaOf();
    assert.equal(restoredQuota.usedBytes, '10');
    assert.equal(restoredQuota.trash.retainedNodeCount, 0);

    // 같은 key로 다시 보내면 최초 응답을 그대로 받고, 새 key로 다시 복구하면 항목이 없어 404다.
    const replay = await ctx.client.restoreTrash(
      ns,
      trashId,
      { targetPath: '/back' },
      { idempotencyKey: key },
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json(), restored.json());
    const again = await ctx.client.restoreTrash(ns, trashId, { targetPath: '/back2' });
    assert.equal(again.status, 404);
    assert.equal(again.json<{ code: string }>().code, 'VFS_TRASH_ITEM_NOT_FOUND');

    await assertLegacyRemove(ctx, ns);
  },
});

/** `/fs/rm`도 휴지통이 켜져 있으면 `X-Trash-Id`로 항목을 알리고 그 항목을 복구할 수 있다. */
async function assertLegacyRemove(ctx: ContractContext, ns: string): Promise<void> {
  const bytes = Buffer.from('legacy');
  const stored = await ctx.client.putConditionalContent(ns, '/legacy.txt', bytes, { ifAbsent: true });
  assert.equal(stored.status, 201);
  const fileId = stored.json<{ resource: { id: string } }>().resource.id;
  const removed = await ctx.client.remove(ns, '/legacy.txt');
  assert.equal(removed.status, 204);
  const trashId = removed.headers.get('x-trash-id');
  assert.ok(trashId, 'X-Trash-Id가 있어야 한다');
  assert.equal((await ctx.client.getStat(ns, '/legacy.txt')).status, 404);
  const restored = await ctx.client.restoreTrash(ns, trashId, {});
  assert.equal(restored.status, 200, restored.text());
  assert.equal(restored.json<{ resource: { id: string } }>().resource.id, fileId);
  assert.deepEqual((await ctx.client.getContent(ns, '/legacy.txt')).bytes, bytes);
}
