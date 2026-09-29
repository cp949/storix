// 소비자 기대: 휴지통은 기본 꺼져 있고 관리자만 namespace별로 바꾼다. 잘못된 요청은 거부되고 정책은 그대로이며, 끈 뒤에도 이미 보존한 항목은 복구할 수 있다.
// 대응 요구사항: RQ-024(파일·디렉터리 삭제), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-trash-policy',
  title:
    '휴지통 정책은 기본 OFF이고 관리자만 namespace별로 바꾸며 잘못된 요청은 무변경이고 끈 뒤에도 기존 항목은 복구된다',
  rq: ['RQ-024', 'RQ-018'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const other = (await ctx.createNamespace()).id;
    const enabledOf = async (id: string): Promise<boolean> => {
      const response = await ctx.client.getNamespace(id);
      assert.equal(response.status, 200, response.text());
      return response.json<{ quota: { trash: { enabled: boolean } } }>().quota.trash.enabled;
    };
    assert.equal(await enabledOf(ns), false);

    // 잘못된 요청은 정책을 바꾸지 않는다. 서비스 key는 401, key 누락은 400, 형식 오류는 400, 없는 namespace는 404다.
    const asService = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.apiKey, { enabled: true });
    assert.equal(asService.status, 401);
    const noKey = await ctx.client.updateNamespaceTrashPolicy(
      ns,
      ctx.adminKey,
      { enabled: true },
      { idempotencyKey: null },
    );
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json<{ code: string }>().code, 'IDEMPOTENCY_KEY_REQUIRED');
    const malformed = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: 'yes' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json<{ code: string }>().code, 'NAMESPACE_INVALID_TRASH_POLICY');
    const unknown = await ctx.client.updateNamespaceTrashPolicy(randomUUID(), ctx.adminKey, {
      enabled: true,
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json<{ code: string }>().code, 'NAMESPACE_NOT_FOUND');
    assert.equal(await enabledOf(ns), false);

    // 켜면 그 namespace에만 적용된다. 같은 key와 본문은 최초 응답을 재생하고, 같은 key에 다른 본문은 422다.
    const key = 'c0a7d3a4-4b8e-4f0a-8a8f-0d3b7f4e9a55';
    const enabled = await ctx.client.updateNamespaceTrashPolicy(
      ns,
      ctx.adminKey,
      { enabled: true },
      { idempotencyKey: key },
    );
    assert.equal(enabled.status, 200, enabled.text());
    assert.equal(await enabledOf(ns), true);
    assert.equal(await enabledOf(other), false);
    const replay = await ctx.client.updateNamespaceTrashPolicy(
      ns,
      ctx.adminKey,
      { enabled: true },
      { idempotencyKey: key },
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json(), enabled.json());
    const reused = await ctx.client.updateNamespaceTrashPolicy(
      ns,
      ctx.adminKey,
      { enabled: false },
      { idempotencyKey: key },
    );
    assert.equal(reused.status, 422);
    assert.equal(reused.json<{ code: string }>().code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await enabledOf(ns), true);

    // 켠 상태에서 지운 파일은 휴지통에 남고, 끈 뒤에도 목록에 있어 복구된다.
    const bytes = Buffer.from('보존할 내용', 'utf-8');
    const created = await ctx.client.putConditionalContent(ns, '/kept.txt', bytes, { ifAbsent: true });
    assert.equal(created.status, 201);
    const resource = created.json<{ resource: { id: string; revision: string } }>().resource;
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/kept.txt',
      ifRevision: resource.revision,
    });
    assert.equal(deleted.status, 200, deleted.text());
    const trashId = deleted.json<{ trashId: string }>().trashId;

    const disabled = await ctx.client.updateNamespaceTrashPolicy(ns, ctx.adminKey, { enabled: false });
    assert.equal(disabled.status, 200, disabled.text());
    assert.equal(await enabledOf(ns), false);
    const listed = await ctx.client.listTrash(ns);
    assert.deepEqual(
      listed.json<{ items: { trashId: string }[] }>().items.map((item) => item.trashId),
      [trashId],
    );

    // 끈 뒤의 삭제는 휴지통을 거치지 않고, 기존 항목은 그대로 복구된다.
    const later = await ctx.client.putConditionalContent(ns, '/later.txt', bytes, { ifAbsent: true });
    const gone = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/later.txt',
      ifRevision: later.json<{ resource: { revision: string } }>().resource.revision,
    });
    assert.equal(gone.status, 200, gone.text());
    assert.equal(gone.json<{ trashId?: string }>().trashId, undefined);
    assert.equal((await ctx.client.listTrash(ns)).json<{ items: unknown[] }>().items.length, 1);
    const restored = await ctx.client.restoreTrash(ns, trashId, {});
    assert.equal(restored.status, 200, restored.text());
    assert.equal(restored.json<{ resource: { id: string } }>().resource.id, resource.id);
    assert.deepEqual((await ctx.client.getContent(ns, '/kept.txt')).bytes, bytes);
  },
});
