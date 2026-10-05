// 소비자 기대: 휴지통 복구는 subtree의 모든 node를 원래 ID와 원래 `createdAt`으로 되살리고, `updatedAt`과 revision은 복구 시점의 새 값으로 발급한다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제). 복구 충돌·ID 보존은 `trash-delete-restore`가 다룬다.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { defineContract } from '../../define-contract.ts';

interface Stat {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
}

export default defineContract({
  id: 'trash-restore-preserves-created-at',
  title: '휴지통 복구는 원래 node ID와 createdAt을 유지하고 updatedAt과 revision은 새로 발급한다',
  rq: ['RQ-024'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const enabled = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text());
    const statOf = async (path: string): Promise<Stat> => {
      const stat = await ctx.client.getStat(ns, path);
      assert.equal(stat.status, 200, path);
      return stat.json<Stat>();
    };

    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    const stored = await ctx.client.putConditionalContent(ns, '/dir/a.txt', Buffer.from('aaaa'), {
      ifAbsent: true,
    });
    assert.equal(stored.status, 201, stored.text());
    const before = { dir: await statOf('/dir'), file: await statOf('/dir/a.txt') };

    // DB 시각 정밀도가 초 단위일 수 있어 복구 시각이 원래 시각과 다른 초가 되도록 기다린다.
    await sleep(1100);
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/dir',
      ifRevision: before.dir.revision,
      recursive: true,
    });
    assert.equal(deleted.status, 200, deleted.text());
    const restored = await ctx.client.restoreTrash(ns, deleted.json<{ trashId: string }>().trashId, {});
    assert.equal(restored.status, 200, restored.text());

    const after = { dir: await statOf('/dir'), file: await statOf('/dir/a.txt') };
    for (const key of ['dir', 'file'] as const) {
      assert.equal(after[key].id, before[key].id, `${key} ID`);
      assert.equal(after[key].createdAt, before[key].createdAt, `${key} createdAt은 원래 값이어야 한다`);
      assert.ok(
        Date.parse(after[key].updatedAt) > Date.parse(before[key].updatedAt),
        `${key} updatedAt은 복구 시점의 새 값이어야 한다`,
      );
      assert.notEqual(after[key].revision, before[key].revision, `${key} revision`);
    }
  },
});
