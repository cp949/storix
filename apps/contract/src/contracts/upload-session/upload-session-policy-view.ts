// 재개 업로드가 열린 namespace의 단건 조회는 정책·한도·현재 사용량을 알린다.
// 사용량은 세션 생성과 조각 저장을 반영한다. 재개 업로드가 비활성이면 블록을 생략한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface UploadSessions {
  /** 새 세션에 고정된 조각 크기. */
  partSizeBytes: number;

  /** 성공한 조각 요청 뒤 적용할 비활동 수명. */
  inactivitySeconds: number;

  /** 세션 생성 시점부터의 최대 수명. */
  maxLifetimeSeconds: number;

  /** namespace staging 상한의 10진 문자열. */
  maxStagedBytes: string;

  /** namespace의 동시 진행 세션 상한. */
  maxActiveSessions: number;

  /** 예약량을 포함한 staging 사용량의 10진 문자열. */
  stagedBytes: string;

  /** namespace에서 진행 중인 세션 수. */
  activeSessions: number;
}

interface SessionCreated {
  /** 발급된 업로드 세션 ID. */
  sessionId: string;

  /** 새 세션에 고정된 조각 크기. */
  partSizeBytes: number;
}

export default defineContract({
  id: 'upload-session-policy-view',
  title:
    '재개 업로드가 열린 namespace의 단건 조회는 정책·한도·사용량 블록을 알리고 사용량이 세션과 조각 저장을 따라가며, 열리지 않은 namespace에는 블록이 없다',
  rq: ['RQ-027'],
  profile: 'resumable-upload',
  async run(ctx) {
    const enabled = (await ctx.createNamespace()).id;
    const disabled = (await ctx.createNamespace({ withoutCapabilities: true })).id;
    const read = async (ns: string): Promise<UploadSessions> => {
      const response = await ctx.client.getNamespace(ns);
      assert.equal(response.status, 200, response.text());
      const body = response.json<{ id: string; status: string; uploadSessions?: UploadSessions }>();
      assert.equal(body.id, ns);
      assert.equal(body.status, 'ACTIVE');
      assert.ok(body.uploadSessions, 'uploadSessions 블록이 없다');
      return body.uploadSessions;
    };

    // 형식: 바이트 한도·사용량은 10진 문자열, 조각 크기·초·개수는 정수다.
    const initial = await read(enabled);
    for (const field of [
      'partSizeBytes',
      'inactivitySeconds',
      'maxLifetimeSeconds',
      'maxActiveSessions',
    ] as const) {
      assert.ok(Number.isInteger(initial[field]) && initial[field] > 0, `${field}: ${initial[field]}`);
    }
    for (const field of ['maxStagedBytes', 'stagedBytes'] as const)
      assert.match(initial[field], /^[0-9]+$/, field);
    assert.ok(BigInt(initial.maxStagedBytes) > 0n);
    assert.ok(initial.inactivitySeconds <= initial.maxLifetimeSeconds);
    assert.equal(initial.stagedBytes, '0');
    assert.equal(initial.activeSessions, 0);

    // 세션 생성은 activeSessions를, 조각 저장은 stagedBytes를 늘린다. 조각 크기는 새 세션의 값과 같다.
    const created = await ctx.client.createUploadSession(enabled, {
      path: '/policy-view.bin',
      sizeBytes: '4',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    });
    assert.equal(created.status, 201, created.text());
    const session = created.json<SessionCreated>();
    assert.equal(session.partSizeBytes, initial.partSizeBytes);
    const afterCreate = await read(enabled);
    assert.equal(afterCreate.activeSessions, 1);
    assert.equal(afterCreate.stagedBytes, '0');

    const piece = Buffer.from('abcd').subarray(0, session.partSizeBytes);
    const stored = await ctx.client.putUploadPart(enabled, session.sessionId, 0, piece);
    assert.equal(stored.status, 200, stored.text());
    const afterPart = await read(enabled);
    assert.equal(afterPart.stagedBytes, String(piece.length));
    assert.equal(afterPart.maxStagedBytes, initial.maxStagedBytes);

    // 취소한 세션은 활성 세션 수에서 즉시 빠진다. 조각 바이트는 삭제가 확인될 때까지 남는다.
    const cancelled = await ctx.client.cancelUploadSession(enabled, session.sessionId);
    assert.equal(cancelled.status, 200, cancelled.text());
    assert.equal((await read(enabled)).activeSessions, 0);

    // 열리지 않은 namespace의 단건 조회에는 블록이 없고 기존 필드는 그대로다.
    const plain = await ctx.client.getNamespace(disabled);
    assert.equal(plain.status, 200, plain.text());
    const plainBody = plain.json<Record<string, unknown>>();
    assert.equal(plainBody.id, disabled);
    assert.ok(!('uploadSessions' in plainBody), '비활성 namespace에 uploadSessions가 있다');
  },
});
