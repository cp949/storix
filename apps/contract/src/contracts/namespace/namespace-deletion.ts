// 소비자 기대: 관리자 삭제 접수 뒤 데이터 접근이 차단되고 같은 이름은 새 UUID로 재사용하며 다른 namespace는 보존된다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-deletion',
  title: '관리자 삭제는 접수 결과를 재생하고 접근 차단·이름 재사용·namespace 격리를 유지한다',
  rq: ['RQ-030'],
  async run(ctx) {
    const target = await ctx.createNamespace();
    const other = await ctx.createNamespace();
    const bytes = Buffer.from('삭제 대상 파일', 'utf-8');
    const kept = Buffer.from('다른 namespace의 파일', 'utf-8');
    for (const [namespaceId, content] of [
      [target.id, bytes],
      [other.id, kept],
    ] as const) {
      const created = await ctx.client.putConditionalContent(namespaceId, '/file.txt', content, {
        ifAbsent: true,
      });
      assert.equal(created.status, 201, created.text());
    }
    const otherBefore = await ctx.client.getNamespace(other.id);
    assert.equal(otherBefore.status, 200, otherBefore.text());
    const otherStat = await ctx.client.getStat(other.id, '/file.txt');
    assert.equal(otherStat.status, 200, otherStat.text());

    // 서비스 key로는 삭제 접수와 관리자 상태 조회 모두 허용되지 않는다.
    for (const response of [
      await ctx.client.deleteNamespace(target.id, ctx.apiKey),
      await ctx.client.getNamespaceDeletion(target.id, ctx.apiKey),
    ]) {
      assert.equal(response.status, 401, response.text());
      assert.equal(response.json<{ code: string }>().code, 'UNAUTHORIZED');
    }
    const active = await ctx.client.getStat(target.id, '/file.txt');
    assert.equal(active.status, 200, active.text());

    const idempotencyKey = randomUUID();
    const accepted = await ctx.client.deleteNamespace(target.id, ctx.adminKey, { idempotencyKey });
    assert.equal(accepted.status, 202, accepted.text());
    assert.deepEqual(accepted.json(), { namespaceId: target.id, status: 'DELETING' });
    assert.equal(accepted.headers.get('location'), `/api/v2/admin/namespaces/${target.id}/deletion`);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    const replay = await ctx.client.deleteNamespace(target.id, ctx.adminKey, { idempotencyKey });
    assert.equal(replay.status, 202, replay.text());
    assert.deepEqual(replay.json(), accepted.json());
    assert.equal(replay.headers.get('location'), accepted.headers.get('location'));
    assert.equal(replay.headers.get('cache-control'), 'no-store');

    // 실제 존재하던 파일도 접수 뒤에는 namespace 부재 오류로 숨긴다.
    for (const response of [
      await ctx.client.getStat(target.id, '/file.txt'),
      await ctx.client.getContent(target.id, '/file.txt'),
    ]) {
      assert.equal(response.status, 404, response.text());
      assert.equal(response.json<{ code: string }>().code, 'NAMESPACE_NOT_FOUND');
    }
    const status = await ctx.client.getNamespaceDeletion(target.id, ctx.adminKey);
    assert.equal(status.status, 200, status.text());
    assert.equal(status.headers.get('cache-control'), 'no-store');
    const operation = status.json<{
      namespaceId: string;
      status: string;
      phase: string;
      requestedAt: string;
      completedAt: string | null;
      blockedReason: string | null;
    }>();
    assert.equal(operation.namespaceId, target.id);
    assert.equal(operation.status, 'DELETING');
    assert.equal(operation.phase, 'UPLOADS');
    assert.ok(Number.isFinite(Date.parse(operation.requestedAt)));
    assert.equal(operation.completedAt, null);
    assert.equal(operation.blockedReason, null);

    // 러너는 GC를 실행하지 않는다. DELETING 커밋만으로 이름을 재사용할 수 있어야 한다.
    const recreated = await ctx.client.request('POST', '/api/v2/namespaces', {
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ name: target.name }),
    });
    assert.equal(recreated.status, 201, recreated.text());
    const replacement = recreated.json<{ id: string; name: string; status: string }>();
    assert.notEqual(replacement.id, target.id);
    assert.equal(replacement.name, target.name);
    assert.equal(replacement.status, 'ACTIVE');
    assert.equal((await ctx.client.getStat(replacement.id, '/file.txt')).status, 404);
    const newFile = await ctx.client.putConditionalContent(replacement.id, '/file.txt', bytes, {
      ifAbsent: true,
    });
    assert.equal(newFile.status, 201, newFile.text());
    const oldReplay = await ctx.client.deleteNamespace(target.id, ctx.adminKey, { idempotencyKey });
    assert.equal(oldReplay.status, 202, oldReplay.text());
    assert.deepEqual(oldReplay.json(), accepted.json());
    const newContent = await ctx.client.getContent(replacement.id, '/file.txt');
    assert.equal(newContent.status, 200, newContent.text());
    assert.deepEqual(newContent.bytes, bytes);

    // 다른 namespace의 상태·quota·파일 metadata·bytes는 그대로다.
    const otherAfter = await ctx.client.getNamespace(other.id);
    assert.equal(otherAfter.status, 200, otherAfter.text());
    assert.deepEqual(otherAfter.json(), otherBefore.json());
    const otherAfterStat = await ctx.client.getStat(other.id, '/file.txt');
    assert.equal(otherAfterStat.status, 200, otherAfterStat.text());
    assert.deepEqual(otherAfterStat.json(), otherStat.json());
    const otherContent = await ctx.client.getContent(other.id, '/file.txt');
    assert.equal(otherContent.status, 200, otherContent.text());
    assert.deepEqual(otherContent.bytes, kept);
  },
});
