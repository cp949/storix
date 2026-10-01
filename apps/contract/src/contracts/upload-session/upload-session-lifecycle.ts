// 소비자 기대: 열린 업로드 세션은 취소할 수 있고 반복 취소는 같은 상태이며, 취소된 세션은 409로, 없는 세션과 다른 namespace의 세션은 서로 구분되지 않는 404로 거부되며 어떤 경우에도 파일이 공개되지 않는다.
// 대응 요구사항: RQ-002(namespace 격리), RQ-009(원자적 저장), RQ-018(안정적인 오류 분류), RQ-027(선택 capability).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface SessionCreated {
  sessionId: string;
  state: string;
  partSizeBytes: number;
}

export default defineContract({
  id: 'upload-session-lifecycle',
  title:
    '열린 업로드 세션은 취소할 수 있고, 취소된 세션은 409로, 없는 세션·다른 namespace의 세션은 같은 404로 거부하며, 취소된 업로드는 파일을 만들지 않는다',
  rq: ['RQ-002', 'RQ-009', 'RQ-018', 'RQ-027'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const other = (await ctx.createNamespace()).id;
    const body = {
      path: '/cancel.bin',
      sizeBytes: '8',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    };
    const created = await ctx.client.createUploadSession(ns, body);
    assert.equal(created.status, 201, created.text());
    const session = created.json<SessionCreated>();
    const piece = Buffer.alloc(session.partSizeBytes, 0x61);
    assert.equal((await ctx.client.putUploadPart(ns, session.sessionId, 0, piece)).status, 200);

    // 다른 namespace에서는 세션의 존재를 알 수 없다. 조회·조각·완료·취소 모두 같은 404다.
    const foreign = [
      await ctx.client.getUploadSession(other, session.sessionId),
      await ctx.client.putUploadPart(other, session.sessionId, 0, piece),
      await ctx.client.completeUploadSession(other, session.sessionId),
      await ctx.client.cancelUploadSession(other, session.sessionId),
    ];
    const unknown = randomUUID();
    const missing = [
      await ctx.client.getUploadSession(ns, unknown),
      await ctx.client.putUploadPart(ns, unknown, 0, piece),
      await ctx.client.completeUploadSession(ns, unknown),
      await ctx.client.cancelUploadSession(ns, unknown),
    ];
    for (const response of [...foreign, ...missing]) {
      assert.equal(response.status, 404, response.text());
      assert.equal(response.json<{ code: string }>().code, 'VFS_UPLOAD_SESSION_NOT_FOUND');
    }
    // 다른 namespace의 시도가 세션을 건드리지 않았다.
    assert.equal(
      (await ctx.client.getUploadSession(ns, session.sessionId)).json<{ state: string }>().state,
      'OPEN',
    );

    // 취소: OPEN만 CANCELLED가 되고 반복 취소는 같은 상태를 돌려준다.
    const cancelled = await ctx.client.cancelUploadSession(ns, session.sessionId);
    assert.equal(cancelled.status, 200, cancelled.text());
    const cancelledState = cancelled.json<{ state: string; path: string }>();
    assert.equal(cancelledState.state, 'CANCELLED');
    assert.equal(cancelledState.path, '/cancel.bin');
    const repeated = await ctx.client.cancelUploadSession(ns, session.sessionId);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.json<{ state: string }>().state, 'CANCELLED');
    assert.equal(
      (await ctx.client.getUploadSession(ns, session.sessionId)).json<{ state: string }>().state,
      'CANCELLED',
    );

    // 취소된 세션은 조각 추가와 완료가 409 `VFS_UPLOAD_SESSION_CLOSED`이고 경로에 파일이 생기지 않는다.
    const closedPart = await ctx.client.putUploadPart(ns, session.sessionId, 1, piece);
    assert.equal(closedPart.status, 409);
    assert.equal(closedPart.json<{ code: string }>().code, 'VFS_UPLOAD_SESSION_CLOSED');
    const closedComplete = await ctx.client.completeUploadSession(ns, session.sessionId);
    assert.equal(closedComplete.status, 409);
    assert.equal(closedComplete.json<{ code: string }>().code, 'VFS_UPLOAD_SESSION_CLOSED');
    assert.equal((await ctx.client.getStat(ns, '/cancel.bin')).status, 404);

    // 같은 경로로 새 세션을 만들어 끝까지 올릴 수 있다. 취소된 세션이 경로를 점유하지 않는다.
    const retry = await ctx.client.createUploadSession(ns, body);
    assert.equal(retry.status, 201, retry.text());
    const retrySession = retry.json<SessionCreated>();
    const full = Buffer.alloc(8, 0x62);
    for (let index = 0; index * retrySession.partSizeBytes < full.length; index += 1) {
      const stored = await ctx.client.putUploadPart(
        ns,
        retrySession.sessionId,
        index,
        full.subarray(index * retrySession.partSizeBytes, (index + 1) * retrySession.partSizeBytes),
      );
      assert.equal(stored.status, 200, `조각 ${index}`);
    }
    const done = await ctx.client.completeUploadSession(ns, retrySession.sessionId);
    assert.equal(done.status, 201, done.text());
    assert.deepEqual((await ctx.client.getContent(ns, '/cancel.bin')).bytes, full);
  },
});
