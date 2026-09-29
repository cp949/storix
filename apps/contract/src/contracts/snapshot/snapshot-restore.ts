// 소비자 기대: snapshot을 지정 경로의 현재 파일로 복원할 수 있고, 조건이 맞지 않으면 변경 없이 충돌하며 snapshot은 그대로 남는다.
// 대응 요구사항: RQ-015(조건부 스냅샷 복원).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

interface RestoreResult {
  snapshotId: string;
  resource: { path: string };
  affectedRevisions: Array<{ path: string; revision: string }>;
}

export default defineContract({
  id: 'snapshot-restore',
  title:
    '오래된 대상 revision의 복원은 412로 거부하고, 정상 복원은 snapshot 바이트와 새 revision을 만들며 snapshot을 보존한다',
  rq: ['RQ-015'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const first = Buffer.from('복원할 첫 내용', 'utf-8');
    const second = Buffer.from('그 뒤에 교체한 내용', 'utf-8');

    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', first, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;
    const snapshotResponse = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.txt' });
    const snapshotId = snapshotResponse.json<{ snapshotId: string }>().snapshotId;
    const replaced = await ctx.client.putConditionalContent(ns, '/doc.txt', second, {
      ifRevision: v1.revision,
    });
    const v2 = replaced.json<ConditionalResult>().resource;

    // 대상이 이미 바뀌었는데 옛 revision으로 복원하면 412이고 현재 파일은 그대로다.
    const stale = await ctx.client.restoreSnapshot(ns, snapshotId, {
      path: '/doc.txt',
      ifRevision: v1.revision,
    });
    assert.equal(stale.status, 412);
    const conflict = stale.json<{ code: string; current: { revision: string } }>();
    assert.equal(conflict.code, 'VFS_PRECONDITION_FAILED');
    assert.equal(conflict.current.revision, v2.revision);
    const unchanged = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(unchanged.bytes, second);
    assert.equal(unchanged.headers.get('x-storix-revision'), v2.revision);

    // 대상이 있는데 부재 조건으로 복원해도 412다.
    const absentOnExisting = await ctx.client.restoreSnapshot(ns, snapshotId, {
      path: '/doc.txt',
      ifAbsent: true,
    });
    assert.equal(absentOnExisting.status, 412);
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.txt')).bytes, second);

    // 조건이 없으면 428이고 아무것도 바뀌지 않는다.
    const noCondition = await ctx.client.restoreSnapshot(ns, snapshotId, { path: '/doc.txt' });
    assert.equal(noCondition.status, 428);
    assert.equal(noCondition.json<{ code: string }>().code, 'VFS_PRECONDITION_REQUIRED');
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.txt')).bytes, second);

    // 현재 revision을 조건으로 하면 snapshot 바이트로 돌아가고 revision은 복원 전과 다르다.
    const restored = await ctx.client.restoreSnapshot(ns, snapshotId, {
      path: '/doc.txt',
      ifRevision: v2.revision,
    });
    assert.equal(restored.status, 200);
    const result = restored.json<RestoreResult>();
    assert.equal(result.snapshotId, snapshotId);
    assert.equal(result.resource.path, '/doc.txt');
    const restoredRevision = result.affectedRevisions.find((item) => item.path === '/doc.txt')?.revision;
    assert.ok(restoredRevision !== undefined, '복원한 파일의 새 revision이 응답에 있어야 한다');
    assert.notEqual(restoredRevision, v2.revision);
    const afterRestore = await ctx.client.getContent(ns, '/doc.txt');
    assert.deepEqual(afterRestore.bytes, first);
    assert.equal(afterRestore.headers.get('x-storix-revision'), restoredRevision);

    // 없는 경로에는 부재 조건으로 복원하며 새 파일이 만들어진다.
    const toNewPath = await ctx.client.restoreSnapshot(ns, snapshotId, { path: '/copy.txt', ifAbsent: true });
    assert.equal(toNewPath.status, 201);
    assert.deepEqual((await ctx.client.getContent(ns, '/copy.txt')).bytes, first);

    // 복원 뒤에도 snapshot은 그대로 읽을 수 있다.
    const snapshotBytes = await ctx.client.getSnapshotContent(ns, snapshotId);
    assert.equal(snapshotBytes.status, 200);
    assert.deepEqual(snapshotBytes.bytes, first);
  },
});
