// 소비자 기대: 다른 namespace에서 얻은 경로·revision·snapshot ID로는 자기 namespace가 아닌 파일과 snapshot을 읽거나 바꿀 수 없다.
// 대응 요구사항: RQ-002(namespace 격리).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

const JSON_MUTATION = { 'Content-Type': 'application/json', 'X-Mutation-Scope': 'storix-contract' };

export default defineContract({
  id: 'namespace-isolation',
  title: '같은 경로와 다른 namespace의 식별자로는 다른 namespace의 파일·snapshot에 접근할 수 없다',
  rq: ['RQ-002'],
  async run(ctx) {
    const a = await ctx.createNamespace();
    const b = await ctx.createNamespace();
    const inA = Buffer.from('namespace A 본문', 'utf-8');
    const inB = Buffer.from('namespace B 본문', 'utf-8');

    const createdA = await ctx.client.putConditionalContent(a.id, '/shared.txt', inA, { ifAbsent: true });
    assert.equal(createdA.status, 201);
    const fileA = createdA.json<ConditionalResult>().resource;

    // 같은 경로라도 B에서는 A의 파일이 보이지 않는다.
    assert.equal((await ctx.client.getContent(b.id, '/shared.txt')).status, 404);
    assert.equal((await ctx.client.getStat(b.id, '/shared.txt')).status, 404);

    // B가 같은 경로를 처음 만드는 요청은 A의 파일과 충돌하지 않고 다른 파일 ID를 받는다.
    const createdB = await ctx.client.putConditionalContent(b.id, '/shared.txt', inB, { ifAbsent: true });
    assert.equal(createdB.status, 201);
    const fileB = createdB.json<ConditionalResult>().resource;
    assert.notEqual(fileB.id, fileA.id);
    assert.deepEqual((await ctx.client.getContent(a.id, '/shared.txt')).bytes, inA);
    assert.deepEqual((await ctx.client.getContent(b.id, '/shared.txt')).bytes, inB);

    // A에서 얻은 revision을 B의 같은 경로 교체 조건으로 써도 통과하지 않고, B의 파일은 그대로다.
    const crossRevision = await ctx.client.putConditionalContent(
      b.id,
      '/shared.txt',
      Buffer.from('교체 시도', 'utf-8'),
      { ifRevision: fileA.revision },
    );
    assert.equal(crossRevision.status, 412);
    const afterCross = await ctx.client.getContent(b.id, '/shared.txt');
    assert.deepEqual(afterCross.bytes, inB);
    assert.equal(afterCross.headers.get('x-storix-revision'), fileB.revision);

    // A의 snapshot은 A에서만 조회·복원된다.
    const snapshot = await ctx.client.request('POST', `/api/v2/namespaces/${a.id}/fs/snapshots`, {
      headers: { ...JSON_MUTATION, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ kind: 'file', path: '/shared.txt' }),
    });
    assert.equal(snapshot.status, 201);
    const snapshotId = snapshot.json<{ snapshotId: string }>().snapshotId;
    const snapshotUrl = (namespaceId: string) =>
      `/api/v2/namespaces/${namespaceId}/fs/snapshots/${snapshotId}`;

    assert.equal((await ctx.client.request('GET', snapshotUrl(a.id))).status, 200);
    assert.equal((await ctx.client.request('GET', snapshotUrl(b.id))).status, 404);
    assert.equal((await ctx.client.request('GET', `${snapshotUrl(b.id)}/content`)).status, 404);
    const foreignRestore = await ctx.client.request('POST', `${snapshotUrl(b.id)}/restore`, {
      headers: { ...JSON_MUTATION, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ path: '/restored.txt', ifAbsent: true }),
    });
    assert.equal(foreignRestore.status, 404);
    assert.equal((await ctx.client.getStat(b.id, '/restored.txt')).status, 404);

    // A에서 파일을 지워도 B의 같은 경로 파일은 그대로다.
    const removed = await ctx.client.request(
      'POST',
      `/api/v2/namespaces/${a.id}/fs/rm?path=${encodeURIComponent('/shared.txt')}`,
    );
    assert.equal(removed.status, 204);
    assert.equal((await ctx.client.getContent(a.id, '/shared.txt')).status, 404);
    assert.deepEqual((await ctx.client.getContent(b.id, '/shared.txt')).bytes, inB);
  },
});
