// 소비자 기대: snapshot으로 보존한 바이트·크기·해시는 원본을 수정·이동·삭제해도 생성 직후와 같다.
// 대응 요구사항: RQ-014(스냅샷 바이트 조회).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { revision: string };
}

interface SnapshotMetadata {
  snapshotId: string;
  sha256: string;
  logicalBytes: string;
}

export default defineContract({
  id: 'snapshot-immutable',
  title: '원본을 수정·이동·삭제해도 snapshot의 바이트·크기·해시가 생성 직후와 같다',
  rq: ['RQ-014'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const original = Buffer.from([0x00, 0xff, 0xfe, 0x0d, 0x0a, ...Buffer.from('보존할 원본', 'utf-8')]);

    const created = await ctx.client.putConditionalContent(ns, '/doc.bin', original, { ifAbsent: true });
    let revision = created.json<ConditionalResult>().resource.revision;
    const response = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.bin' });
    assert.equal(response.status, 201);
    const snapshot = response.json<SnapshotMetadata>();
    assert.equal(snapshot.sha256, createHash('sha256').update(original).digest('hex'));
    assert.equal(snapshot.logicalBytes, String(original.length));

    // 생성 직후의 바이트가 기준이고, 이후 어떤 원본 변경에도 같은 값을 돌려줘야 한다.
    const expectSnapshotUnchanged = async (step: string) => {
      const content = await ctx.client.getSnapshotContent(ns, snapshot.snapshotId);
      assert.equal(content.status, 200, `${step}: 내용 조회 실패`);
      assert.deepEqual(content.bytes, original, `${step}: snapshot 바이트가 바뀌었다`);
      const metadata = (await ctx.client.getSnapshot(ns, snapshot.snapshotId)).json<SnapshotMetadata>();
      assert.equal(metadata.sha256, snapshot.sha256, `${step}: 해시가 바뀌었다`);
      assert.equal(metadata.logicalBytes, snapshot.logicalBytes, `${step}: 크기가 바뀌었다`);
    };
    await expectSnapshotUnchanged('생성 직후');

    // 원본 수정
    const replaced = await ctx.client.putConditionalContent(
      ns,
      '/doc.bin',
      Buffer.from('전혀 다른 내용', 'utf-8'),
      {
        ifRevision: revision,
      },
    );
    assert.equal(replaced.status, 200);
    revision = replaced.json<ConditionalResult>().resource.revision;
    await expectSnapshotUnchanged('원본 수정 뒤');

    // 원본 이동
    const moved = await ctx.client.postMutation(ns, {
      kind: 'move',
      source: '/doc.bin',
      destination: '/moved.bin',
      sourceRevision: revision,
      destinationAbsent: true,
      destinationResolution: 'exact',
    });
    assert.equal(moved.status, 200);
    await expectSnapshotUnchanged('원본 이동 뒤');

    // 원본 삭제
    const movedRevision = (await ctx.client.getStat(ns, '/moved.bin')).json<{ revision: string }>().revision;
    const removed = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/moved.bin',
      ifRevision: movedRevision,
    });
    assert.equal(removed.status, 200);
    assert.equal((await ctx.client.getStat(ns, '/moved.bin')).status, 404);
    await expectSnapshotUnchanged('원본 삭제 뒤');
  },
});
