// 소비자 기대: 휴지통 복구·purge는 JSON이 아닌 Content-Type의 본문을 조용히 무시하지 않고 400 `VFS_INVALID_MUTATION_REQUEST`로 거부하며, 같은 `Idempotency-Key`로 JSON 본문을 다시 보내면 정상 처리된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성: fingerprint 이전 오류는 receipt 없이 재평가), RQ-018(안정적인 오류 분류). 헤더 오류는 `mutation-header-validation-lifecycle`이 다룬다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'trash-restore-non-json-body',
  title:
    '휴지통 복구·purge의 비JSON 본문은 400 VFS_INVALID_MUTATION_REQUEST로 거부하고 targetPath를 무시한 채 복구하지 않는다',
  rq: ['RQ-011', 'RQ-018'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const fs = `/api/v2/namespaces/${ns}/fs`;
    const enabled = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text());
    assert.equal((await ctx.client.mkdir(ns, '/other')).status, 201);

    const stored = await ctx.client.putConditionalContent(ns, '/doc.txt', Buffer.from('doc'), {
      ifAbsent: true,
    });
    assert.equal(stored.status, 201, stored.text());
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/doc.txt',
      ifRevision: stored.json<{ resource: { revision: string } }>().resource.revision,
    });
    assert.equal(deleted.status, 200, deleted.text());
    const trashId = deleted.json<{ trashId: string }>().trashId;

    // text/plain으로 보낸 targetPath는 무시되어 원래 경로로 복구되면 안 된다. 400이고 항목과 경로는 그대로다.
    const key = randomUUID();
    const rejected = await ctx.client.request('POST', `${fs}/trash/${trashId}/restore`, {
      headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': key, 'X-Mutation-Scope': 'contract' },
      body: JSON.stringify({ targetPath: '/other/doc.txt' }),
    });
    assert.equal(rejected.status, 400, rejected.text());
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_INVALID_MUTATION_REQUEST');
    assert.equal((await ctx.client.getStat(ns, '/doc.txt')).status, 404);
    assert.equal((await ctx.client.getStat(ns, '/other/doc.txt')).status, 404);
    assert.deepEqual(
      (await ctx.client.listTrash(ns)).json<{ items: { trashId: string }[] }>().items.map((i) => i.trashId),
      [trashId],
    );

    // purge도 비JSON 본문을 거부하고 항목이 남는다.
    const purge = await ctx.client.request('POST', `${fs}/trash/${trashId}/purge`, {
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        'Content-Type': 'text/plain',
        'Idempotency-Key': randomUUID(),
        'X-Mutation-Scope': 'contract',
      },
      body: 'x',
    });
    assert.equal(purge.status, 400, purge.text());
    assert.equal(purge.json<{ code: string }>().code, 'VFS_INVALID_MUTATION_REQUEST');
    assert.equal((await ctx.client.listTrash(ns)).json<{ items: unknown[] }>().items.length, 1);

    // 거부는 receipt를 남기지 않으므로 같은 key로 JSON 본문을 보내면 targetPath로 복구된다.
    const restored = await ctx.client.restoreTrash(
      ns,
      trashId,
      { targetPath: '/other/doc.txt' },
      { idempotencyKey: key },
    );
    assert.equal(restored.status, 200, restored.text());
    assert.equal((await ctx.client.getStat(ns, '/other/doc.txt')).status, 200);
    assert.equal((await ctx.client.getStat(ns, '/doc.txt')).status, 404);
  },
});
