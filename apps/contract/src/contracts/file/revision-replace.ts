// 소비자 기대: 읽은 revision을 조건으로 파일 전체를 교체할 수 있고, 오래된 revision은 충돌로 거부되며 기존 파일은 바뀌지 않는다.
// 대응 요구사항: RQ-008(revision 조건부 전체 교체).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string; updatedAt: string };
}

interface Stat {
  revision: string;
  updatedAt: string;
}

export default defineContract({
  id: 'revision-replace',
  title:
    'revision이 맞으면 전체 교체하고 revision을 바꾸며, 오래된 revision은 412로 거부하고 파일을 유지한다',
  rq: ['RQ-008'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const original = Buffer.from('원본', 'utf-8');
    const updated = Buffer.from('교체 본문', 'utf-8');
    const stale = Buffer.from('오래된 revision으로 쓰려는 본문', 'utf-8');

    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', original, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;

    // 읽은 revision을 조건으로 하면 교체되고 새 revision이 발급된다.
    const replaced = await ctx.client.putConditionalContent(ns, '/doc.txt', updated, {
      ifRevision: v1.revision,
    });
    assert.equal(replaced.status, 200);
    const v2 = replaced.json<ConditionalResult>().resource;
    assert.equal(v2.id, v1.id);
    assert.notEqual(v2.revision, v1.revision);
    const afterReplace = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(afterReplace.bytes, updated);
    assert.equal(afterReplace.headers.get('x-storix-revision'), v2.revision);

    // 이미 지나간 revision을 조건으로 하면 충돌로 거부하고 현재 상태를 알려 준다.
    const before = (await ctx.client.getStat(ns, '/doc.txt')).json<Stat>();
    const conflict = await ctx.client.putConditionalContent(ns, '/doc.txt', stale, {
      ifRevision: v1.revision,
    });
    assert.equal(conflict.status, 412);
    const current = conflict.json<{ code: string; current: { id: string; revision: string } }>();
    assert.equal(current.code, 'VFS_PRECONDITION_FAILED');
    assert.equal(current.current.revision, v2.revision);

    // 거부한 뒤에도 바이트·revision·수정 시각이 그대로다.
    const after = (await ctx.client.getStat(ns, '/doc.txt')).json<Stat>();
    assert.deepEqual(after, before);
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.txt')).bytes, updated);

    // 없는 파일은 revision 조건으로 만들 수 없다. 오류 상태 코드는 요구사항이 정하지 않아 거부 여부만 본다.
    const missing = await ctx.client.putConditionalContent(ns, '/absent.txt', stale, {
      ifRevision: v2.revision,
    });
    assert.ok(missing.status >= 400, `거부해야 한다: ${missing.status}`);
    assert.equal((await ctx.client.getStat(ns, '/absent.txt')).status, 404);
  },
});
