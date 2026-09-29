// 소비자 기대: 파일의 현재 revision을 조건으로 snapshot을 만들 수 있고, 조건이 맞지 않으면 snapshot이 남지 않는다.
// 대응 요구사항: RQ-012(스냅샷 생성).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ConditionalResult {
  resource: { id: string; revision: string };
}

interface SnapshotMetadata {
  snapshotId: string;
  kind: string;
  sourcePath: string;
  sourceRevision: string;
  rootNodeId: string;
  sha256: string;
  logicalBytes: string;
  createdAt: string;
}

export default defineContract({
  id: 'snapshot-create',
  title:
    'revision 조건으로 snapshot을 만들고 원본 정보·크기·해시를 돌려주며, 조건 불일치는 412로 거부하고 남기지 않는다',
  rq: ['RQ-012'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const original = Buffer.from('스냅샷 원본 내용', 'utf-8');

    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', original, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;

    // 현재 revision이 맞으면 201이고 원본 파일 ID·경로·revision·크기·해시·생성 시각을 돌려준다.
    const response = await ctx.client.createSnapshot(ns, {
      kind: 'file',
      path: '/doc.txt',
      sourceRevision: v1.revision,
    });
    assert.equal(response.status, 201);
    const snapshot = response.json<SnapshotMetadata>();
    assert.match(snapshot.snapshotId, UUID);
    assert.equal(snapshot.kind, 'file');
    assert.equal(snapshot.sourcePath, '/doc.txt');
    assert.equal(snapshot.sourceRevision, v1.revision);
    assert.equal(snapshot.rootNodeId, v1.id);
    assert.equal(snapshot.logicalBytes, String(original.length));
    assert.equal(snapshot.sha256, createHash('sha256').update(original).digest('hex'));
    assert.ok(!Number.isNaN(Date.parse(snapshot.createdAt)), 'createdAt이 날짜 형식이어야 한다');
    assert.deepEqual((await ctx.client.getSnapshot(ns, snapshot.snapshotId)).json(), snapshot);

    // 원본이 바뀐 뒤 옛 revision을 조건으로 하면 412이고 현재 원본 정보를 알려 준다.
    const replaced = await ctx.client.putConditionalContent(ns, '/doc.txt', Buffer.from('교체', 'utf-8'), {
      ifRevision: v1.revision,
    });
    const v2 = replaced.json<ConditionalResult>().resource;
    const conflict = await ctx.client.createSnapshot(ns, {
      kind: 'file',
      path: '/doc.txt',
      sourceRevision: v1.revision,
    });
    assert.equal(conflict.status, 412);
    const body = conflict.json<{ code: string; current: { id: string; revision: string } }>();
    assert.equal(body.code, 'VFS_PRECONDITION_FAILED');
    assert.equal(body.current.revision, v2.revision);

    // 거부된 요청은 snapshot을 남기지 않는다. 이 파일의 snapshot은 처음 만든 1건뿐이다.
    const list = (await ctx.client.listSnapshots(ns, v1.id)).json<{ items: Array<{ snapshotId: string }> }>();
    assert.deepEqual(
      list.items.map((item) => item.snapshotId),
      [snapshot.snapshotId],
    );
  },
});
