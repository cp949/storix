// 소비자 기대: 업로드 세션 완료가 저장 한도 초과로 실패하면 세션은 OPEN으로 돌아가 조각을 유지하고, 조회가 마지막 실패의 코드와 시각을 알리며, 한도를 해소한 재완료가 성공하면 실패 정보가 사라진다.
// 대응 요구사항: RQ-009(원자적 파일 저장), RQ-017(크기 및 저장량 한도).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface SessionCreated {
  sessionId: string;
  partSizeBytes: number;
  partCount: number;
}

interface SessionStatus {
  state: string;
  lastCompleteFailure?: { code: string; at: string };
}

export default defineContract({
  id: 'upload-session-complete-failure',
  title:
    '업로드 세션 완료가 저장량 한도로 실패하면 OPEN으로 돌아가 마지막 실패의 코드와 시각을 알리고 조각 재전송으로 지워지지 않으며 재완료 성공 뒤에는 사라진다',
  rq: ['RQ-009', 'RQ-017'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const data = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28]);

    // 저장량 상한을 파일보다 작게 줄인다. 세션 생성은 상한을 미리 검사하지 않는다.
    const lowered = await ctx.client.updateNamespaceQuota(ns, ctx.adminKey, { maxTotalLogicalBytes: '3' });
    assert.equal(lowered.status, 200, lowered.text());
    const created = await ctx.client.createUploadSession(ns, {
      path: '/quota.bin',
      sizeBytes: String(data.length),
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    });
    assert.equal(created.status, 201, created.text());
    const { sessionId, partSizeBytes, partCount } = created.json<SessionCreated>();
    const piece = (index: number): Buffer =>
      data.subarray(index * partSizeBytes, (index + 1) * partSizeBytes);
    for (let index = 0; index < partCount; index += 1) {
      const stored = await ctx.client.putUploadPart(ns, sessionId, index, piece(index));
      assert.equal(stored.status, 200, `조각 ${index}: ${stored.text()}`);
    }

    // 완료는 413 VFS_QUOTA_EXCEEDED로 실패하고 경로에 파일이 생기지 않는다.
    const before = Date.now();
    const failed = await ctx.client.completeUploadSession(ns, sessionId);
    assert.equal(failed.status, 413, failed.text());
    assert.equal(failed.json<{ code: string }>().code, 'VFS_QUOTA_EXCEEDED');
    assert.equal((await ctx.client.getStat(ns, '/quota.bin')).status, 404);

    // 세션은 OPEN이고 마지막 실패의 코드와 시각을 알린다. 시각은 서버 시계라 호출 시점 앞뒤의 넉넉한 범위로만 본다.
    const afterFailure = await ctx.client.getUploadSession(ns, sessionId);
    assert.equal(afterFailure.status, 200, afterFailure.text());
    const failure = afterFailure.json<SessionStatus>();
    assert.equal(failure.state, 'OPEN');
    assert.equal(failure.lastCompleteFailure?.code, 'VFS_QUOTA_EXCEEDED');
    const failedAt = Date.parse(failure.lastCompleteFailure?.at ?? '');
    assert.ok(Number.isFinite(failedAt), '실패 시각은 date-time이어야 한다');
    assert.ok(Math.abs(failedAt - before) < 10 * 60 * 1000, '실패 시각은 호출 시점과 가까워야 한다');

    // 조각 재전송은 실패 정보를 지우지 않고 저장된 조각은 그대로다.
    const replayed = await ctx.client.putUploadPart(ns, sessionId, 0, piece(0));
    assert.equal(replayed.status, 200, replayed.text());
    assert.equal(replayed.json<{ replayed: boolean }>().replayed, true);
    const afterReplay = (await ctx.client.getUploadSession(ns, sessionId)).json<SessionStatus>();
    assert.equal(afterReplay.lastCompleteFailure?.code, 'VFS_QUOTA_EXCEEDED');

    // 상한을 전역 값으로 되돌린 뒤 재완료하면 성공하고 실패 정보는 사라진다.
    const restored = await ctx.client.updateNamespaceQuota(ns, ctx.adminKey, { maxTotalLogicalBytes: null });
    assert.equal(restored.status, 200, restored.text());
    const completed = await ctx.client.completeUploadSession(ns, sessionId);
    assert.equal(completed.status, 201, completed.text());
    const done = await ctx.client.getUploadSession(ns, sessionId);
    const finalState = done.json<SessionStatus>();
    assert.equal(finalState.state, 'COMPLETED');
    assert.equal(finalState.lastCompleteFailure, undefined, '종결 뒤에는 실패 정보가 없어야 한다');
    assert.deepEqual((await ctx.client.getContent(ns, '/quota.bin')).bytes, data);
  },
});
