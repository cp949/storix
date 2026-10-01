// 소비자 기대: snapshot 생성·복원·삭제도 같은 멱등성 키로 같은 요청을 다시 보내면 변경 없이 최초 결과를 돌려받고, 다른 요청에 같은 키를 쓰면 거부된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성). 조건부 저장·mutation delete는 `mutation-replay`가 다룬다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

interface ConditionalResult {
  resource: { id: string; revision: string };
}

interface SnapshotMetadata {
  snapshotId: string;
  rootNodeId: string;
}

/** 재전송 응답이 최초 응답과 status·본문·`X-Request-Id`까지 같은지 확인한다. */
function assertReplayed(replay: ApiResponse, first: ApiResponse, label: string): void {
  assert.equal(replay.status, first.status, `${label}: ${replay.text()}`);
  assert.deepEqual(replay.json(), first.json(), label);
  assert.equal(replay.headers.get('x-request-id'), first.headers.get('x-request-id'), label);
}

function assertKeyReused(response: ApiResponse, label: string): void {
  assert.equal(response.status, 409, `${label}: ${response.text()}`);
  assert.equal(response.json<{ code: string }>().code, 'MUTATION_KEY_REUSED', label);
}

export default defineContract({
  id: 'snapshot-mutation-replay',
  title:
    'snapshot 생성·복원·삭제는 같은 키의 같은 요청을 최초 결과로 재생하고 한 번만 적용하며, 같은 키의 다른 요청은 409로 거부한다',
  rq: ['RQ-011'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const original = Buffer.from('스냅샷에 보존할 내용', 'utf-8');
    const created = await ctx.client.putConditionalContent(ns, '/a.txt', original, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;

    // 생성: 응답을 못 받았다고 가정하고 같은 키로 다시 보낸다. 그 사이 원본이 바뀌어도 새 snapshot이 생기지 않는다.
    const createKey = randomUUID();
    const createBody = { kind: 'file', path: '/a.txt' };
    const createdSnapshot = await ctx.client.createSnapshot(ns, createBody, { idempotencyKey: createKey });
    assert.equal(createdSnapshot.status, 201);
    const snapshot = createdSnapshot.json<SnapshotMetadata>();
    const changed = Buffer.from('그 뒤에 바뀐 원본', 'utf-8');
    const replaced = await ctx.client.putConditionalContent(ns, '/a.txt', changed, {
      ifRevision: v1.revision,
    });
    assert.equal(replaced.status, 200);

    const createReplay = await ctx.client.createSnapshot(ns, createBody, { idempotencyKey: createKey });
    assertReplayed(createReplay, createdSnapshot, '생성 재전송');
    const listed = await ctx.client.listSnapshots(ns, snapshot.rootNodeId);
    assert.equal(
      listed.json<{ items: unknown[] }>().items.length,
      1,
      '재전송이 snapshot을 한 번 더 만들었다',
    );
    assert.deepEqual(
      (await ctx.client.getSnapshotContent(ns, snapshot.snapshotId)).bytes,
      original,
      '재전송이 snapshot을 바뀐 원본으로 다시 캡처했다',
    );
    // 같은 키로 조건을 더한 다른 요청은 재사용 오류다.
    assertKeyReused(
      await ctx.client.createSnapshot(
        ns,
        { ...createBody, sourceRevision: v1.revision },
        { idempotencyKey: createKey },
      ),
      '생성 키 재사용',
    );

    // 복원: 복원한 파일을 그 뒤에 바꿔도 재전송은 최초 응답을 돌려주고 다시 복원하지 않는다.
    const restoreKey = randomUUID();
    const restoreBody = { path: '/restored.txt', ifAbsent: true };
    const restored = await ctx.client.restoreSnapshot(ns, snapshot.snapshotId, restoreBody, {
      idempotencyKey: restoreKey,
    });
    assert.ok(restored.status === 200 || restored.status === 201, restored.text());
    assert.deepEqual((await ctx.client.getContent(ns, '/restored.txt')).bytes, original);
    const restoredRevision = (await ctx.client.getContent(ns, '/restored.txt')).headers.get(
      'x-storix-revision',
    );
    assert.ok(restoredRevision !== null);
    const edited = Buffer.from('복원 뒤 다시 바꾼 내용', 'utf-8');
    const editedResponse = await ctx.client.putConditionalContent(ns, '/restored.txt', edited, {
      ifRevision: restoredRevision,
    });
    assert.equal(editedResponse.status, 200);

    const restoreReplay = await ctx.client.restoreSnapshot(ns, snapshot.snapshotId, restoreBody, {
      idempotencyKey: restoreKey,
    });
    assertReplayed(restoreReplay, restored, '복원 재전송');
    assert.deepEqual(
      (await ctx.client.getContent(ns, '/restored.txt')).bytes,
      edited,
      '재전송이 복원을 다시 적용했다',
    );
    // 같은 키로 대상 경로가 다른 복원은 재사용 오류이고 새 경로가 생기지 않는다.
    assertKeyReused(
      await ctx.client.restoreSnapshot(
        ns,
        snapshot.snapshotId,
        { path: '/other.txt', ifAbsent: true },
        { idempotencyKey: restoreKey },
      ),
      '복원 키 재사용',
    );
    assert.equal((await ctx.client.getContent(ns, '/other.txt')).status, 404);

    // 삭제: snapshot이 이미 지워진 뒤의 재전송도 최초 200을 돌려주고, 다른 snapshot은 건드리지 않는다.
    const second = await ctx.client.createSnapshot(ns, createBody);
    assert.equal(second.status, 201);
    const secondId = second.json<SnapshotMetadata>().snapshotId;
    const deleteKey = randomUUID();
    const deleted = await ctx.client.deleteSnapshot(ns, snapshot.snapshotId, { idempotencyKey: deleteKey });
    assert.equal(deleted.status, 200);
    assert.equal((await ctx.client.getSnapshot(ns, snapshot.snapshotId)).status, 404);

    const deleteReplay = await ctx.client.deleteSnapshot(ns, snapshot.snapshotId, {
      idempotencyKey: deleteKey,
    });
    assertReplayed(deleteReplay, deleted, '삭제 재전송');
    // 새 키로 같은 snapshot을 지우면 이미 없으므로 404다. 재전송의 200은 receipt 재생이다.
    const deleteAgain = await ctx.client.deleteSnapshot(ns, snapshot.snapshotId);
    assert.equal(deleteAgain.status, 404);
    assert.equal(deleteAgain.json<{ code: string }>().code, 'VFS_SNAPSHOT_NOT_FOUND');
    // 같은 키로 다른 snapshot을 지우는 요청은 재사용 오류이고 그 snapshot은 남는다.
    assertKeyReused(
      await ctx.client.deleteSnapshot(ns, secondId, { idempotencyKey: deleteKey }),
      '삭제 키 재사용',
    );
    assert.equal((await ctx.client.getSnapshot(ns, secondId)).status, 200);
  },
});
