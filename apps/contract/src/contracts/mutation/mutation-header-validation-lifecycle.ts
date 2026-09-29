// 소비자 기대: snapshot 복원·삭제와 휴지통 복구·purge도 `Idempotency-Key`·`X-Mutation-Scope`가 없거나 틀리면 400 `VFS_INVALID_MUTATION_REQUEST`로 거부되고 아무것도 바뀌지 않으며, 헤더를 고쳐 다시 보내면 정상 처리된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성: fingerprint 이전 오류는 receipt 없이 재평가), RQ-018(안정적인 오류 분류). 조건부 저장·mutation·snapshot 생성은 `mutation-header-validation`이 다룬다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

/** 정상 헤더에서 한 가지씩 빼거나 망가뜨린 경우. `null`은 헤더를 보내지 않는다. */
const BAD_HEADERS: ReadonlyArray<{ name: string; key: string | null; scope: string | null }> = [
  { name: 'key 없음', key: null, scope: 'contract' },
  { name: 'scope 없음', key: randomUUID(), scope: null },
  { name: 'key가 UUID가 아님', key: 'not-a-uuid', scope: 'contract' },
  { name: 'scope가 빈 값', key: randomUUID(), scope: '' },
  { name: 'scope가 129바이트', key: randomUUID(), scope: 'a'.repeat(129) },
];

function headersOf(
  bad: { key: string | null; scope: string | null },
  extra: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (bad.key !== null) headers['Idempotency-Key'] = bad.key;
  if (bad.scope !== null) headers['X-Mutation-Scope'] = bad.scope;
  return headers;
}

function assertHeaderRejected(response: ApiResponse, label: string): void {
  assert.equal(response.status, 400, `${label}: ${response.text()}`);
  assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_MUTATION_REQUEST', label);
}

export default defineContract({
  id: 'mutation-header-validation-lifecycle',
  title:
    'snapshot 복원·삭제와 휴지통 복구·purge의 Idempotency-Key·X-Mutation-Scope 오류는 400 VFS_INVALID_MUTATION_REQUEST로 거부하고 상태를 바꾸지 않는다',
  rq: ['RQ-011', 'RQ-018'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const fs = `/api/v2/namespaces/${ns}/fs`;
    const admin = { Authorization: `Bearer ${ctx.adminKey}` };
    const enabled = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text());

    const bytes = Buffer.from('수명주기');
    const seed = await ctx.client.putConditionalContent(ns, '/seed.txt', bytes, { ifAbsent: true });
    assert.equal(seed.status, 201);
    const snapshot = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/seed.txt' });
    assert.equal(snapshot.status, 201, snapshot.text());
    const snapshotId = snapshot.json<{ snapshotId: string }>().snapshotId;

    // 휴지통에 파일 둘을 보낸다. 하나는 복구, 하나는 purge에 쓴다.
    const trashed = async (path: string): Promise<string> => {
      const stored = await ctx.client.putConditionalContent(ns, path, bytes, { ifAbsent: true });
      assert.equal(stored.status, 201, path);
      const deleted = await ctx.client.postMutation(ns, {
        kind: 'delete',
        path,
        ifRevision: stored.json<{ resource: { revision: string } }>().resource.revision,
      });
      assert.equal(deleted.status, 200, deleted.text());
      return deleted.json<{ trashId: string }>().trashId;
    };
    const restoreId = await trashed('/restore-me.txt');
    const purgeId = await trashed('/purge-me.txt');
    const trashIds = async (): Promise<string[]> =>
      (await ctx.client.listTrash(ns)).json<{ items: { trashId: string }[] }>().items.map((i) => i.trashId);
    const expectedTrash = [restoreId, purgeId].sort();

    for (const bad of BAD_HEADERS) {
      // snapshot 복원: 새 경로가 생기지 않는다.
      const restoreSnapshot = await ctx.client.request('POST', `${fs}/snapshots/${snapshotId}/restore`, {
        headers: headersOf(bad, {}),
        body: JSON.stringify({ path: '/from-snapshot.txt', ifAbsent: true }),
      });
      assertHeaderRejected(restoreSnapshot, `snapshot restore ${bad.name}`);

      // snapshot 삭제: snapshot이 남는다.
      const deleteSnapshot = await ctx.client.request('POST', `${fs}/snapshots/${snapshotId}/delete`, {
        headers: headersOf(bad, {}),
        body: '{}',
      });
      assertHeaderRejected(deleteSnapshot, `snapshot delete ${bad.name}`);

      // 휴지통 복구: 항목이 남고 경로가 되살아나지 않는다.
      const restoreTrash = await ctx.client.request('POST', `${fs}/trash/${restoreId}/restore`, {
        headers: headersOf(bad, {}),
        body: '{}',
      });
      assertHeaderRejected(restoreTrash, `trash restore ${bad.name}`);

      // 휴지통 purge: 관리자 key로 보내도 헤더가 틀리면 항목이 남는다.
      const purgeTrash = await ctx.client.request('POST', `${fs}/trash/${purgeId}/purge`, {
        headers: headersOf(bad, admin),
        body: '{}',
      });
      assertHeaderRejected(purgeTrash, `trash purge ${bad.name}`);
    }
    assert.equal((await ctx.client.getStat(ns, '/from-snapshot.txt')).status, 404);
    assert.equal((await ctx.client.getSnapshot(ns, snapshotId)).status, 200);
    assert.equal((await ctx.client.getStat(ns, '/restore-me.txt')).status, 404);
    assert.deepEqual((await trashIds()).sort(), expectedTrash);

    // 헤더를 고쳐 다시 보내면 receipt가 남지 않았으므로 정상 처리된다.
    const boundaryScope = 'a'.repeat(128);
    const valid = (extra: Record<string, string> = {}): Record<string, string> => ({
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      'X-Mutation-Scope': boundaryScope,
      ...extra,
    });
    const restoredSnapshot = await ctx.client.request('POST', `${fs}/snapshots/${snapshotId}/restore`, {
      headers: valid(),
      body: JSON.stringify({ path: '/from-snapshot.txt', ifAbsent: true }),
    });
    assert.equal(restoredSnapshot.status, 201, restoredSnapshot.text());
    assert.deepEqual((await ctx.client.getContent(ns, '/from-snapshot.txt')).bytes, bytes);
    const restoredTrash = await ctx.client.request('POST', `${fs}/trash/${restoreId}/restore`, {
      headers: valid(),
      body: '{}',
    });
    assert.equal(restoredTrash.status, 200, restoredTrash.text());
    assert.deepEqual((await ctx.client.getContent(ns, '/restore-me.txt')).bytes, bytes);
    const purged = await ctx.client.request('POST', `${fs}/trash/${purgeId}/purge`, {
      headers: valid(admin),
      body: '{}',
    });
    assert.equal(purged.status, 200, purged.text());
    assert.deepEqual(await trashIds(), []);
    const deletedSnapshot = await ctx.client.request('POST', `${fs}/snapshots/${snapshotId}/delete`, {
      headers: valid(),
      body: '{}',
    });
    assert.equal(deletedSnapshot.status, 200, deletedSnapshot.text());
    assert.equal((await ctx.client.getSnapshot(ns, snapshotId)).status, 404);
  },
});
