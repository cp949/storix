// 소비자 기대: ls의 consistency가 지원하지 않는 값이면 cursor 오류가 아닌 쿼리 오류(400 VFS_INVALID_QUERY)로 거부되고, revision은 계속 쓸 수 있다.
// 대응 요구사항: RQ-022(디렉터리 자식 목록과 cursor 일관성), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'ls-consistency-validation',
  title: 'ls의 consistency가 revision이 아니면 400 VFS_INVALID_QUERY로 거부되고 revision은 정상 동작한다',
  rq: ['RQ-018', 'RQ-022'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    assert.equal((await ctx.client.mkdir(ns, '/d')).status, 201);
    const created = await ctx.client.putConditionalContent(ns, '/d/a.txt', Buffer.from('a'), {
      ifAbsent: true,
    });
    assert.equal(created.status, 201, created.text());

    const list = (query: string) =>
      ctx.client.request('GET', `/api/v2/namespaces/${ns}/fs/ls?path=%2Fd&${query}`);

    // cursor를 보내지 않았으므로 cursor 오류가 아니라 쿼리 오류다.
    for (const query of [
      'consistency=snapshot',
      'consistency=Revision',
      'consistency=',
      'consistency=revision&consistency=revision',
    ]) {
      const rejected = await list(query);
      assert.equal(rejected.status, 400, `${query}: ${rejected.text()}`);
      assert.equal(rejected.json<{ code: string }>().code, 'VFS_INVALID_QUERY', query);
    }

    // 거부된 뒤에도 revision과 생략은 그대로 동작한다.
    const revision = await list('consistency=revision');
    assert.equal(revision.status, 200, revision.text());
    assert.ok(typeof revision.json<{ directoryRevision: string }>().directoryRevision === 'string');
    const legacy = await ctx.client.listDirectory(ns, '/d');
    assert.equal(legacy.status, 200, legacy.text());
    assert.ok(!('directoryRevision' in legacy.json<object>()));
  },
});
