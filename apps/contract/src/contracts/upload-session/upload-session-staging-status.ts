// 소비자 기대: 열린 세션 조회는 현재 staging 한도와 진행 상태를 알리고 종결 뒤에는 진단을 생략한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface SessionCreated {
  sessionId: string;
}

export default defineContract({
  id: 'upload-session-staging-status',
  title: '열린 업로드 세션 조회는 현재 staging 진단을 제공하고 종결 세션 조회는 해당 필드를 생략한다',
  rq: ['RQ-004', 'RQ-005', 'RQ-008', 'RQ-009', 'RQ-011'],
  profile: 'resumable-upload',
  async run(ctx) {
    const namespaceId = (await ctx.createNamespace()).id;
    const withinLimit = await ctx.client.createUploadSession(namespaceId, {
      path: '/within-limit.bin',
      sizeBytes: '4',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    });
    assert.equal(withinLimit.status, 201, withinLimit.text());
    const session = withinLimit.json<SessionCreated>();
    const open = await ctx.client.getUploadSession(namespaceId, session.sessionId);
    assert.equal(open.status, 200);
    const openBody = open.json<{ staging: { maxStagedBytes: string; status: string }; parts: unknown[] }>();
    assert.deepEqual(openBody.staging, { maxStagedBytes: '1048576', status: 'WITHIN_LIMIT' });
    assert.deepEqual(openBody.parts, []);
    assert.deepEqual(Object.keys(openBody.staging).sort(), ['maxStagedBytes', 'status']);

    const empty = await ctx.client.createUploadSession(namespaceId, {
      path: '/empty.bin',
      sizeBytes: '0',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    });
    assert.equal(empty.status, 201, empty.text());
    const emptySession = empty.json<SessionCreated>();
    const emptyOpen = await ctx.client.getUploadSession(namespaceId, emptySession.sessionId);
    assert.equal(emptyOpen.json<{ staging: { status: string } }>().staging.status, 'PARTS_STORED');
    const complete = await ctx.client.completeUploadSession(namespaceId, emptySession.sessionId);
    assert.equal(complete.status, 201, complete.text());
    const terminal = await ctx.client.getUploadSession(namespaceId, emptySession.sessionId);
    assert.equal(terminal.status, 200);
    assert.equal('staging' in terminal.json<Record<string, unknown>>(), false);

    const cancelled = await ctx.client.cancelUploadSession(namespaceId, session.sessionId);
    assert.equal(cancelled.status, 200);
    const cancelledStatus = await ctx.client.getUploadSession(namespaceId, session.sessionId);
    assert.equal('staging' in cancelledStatus.json<Record<string, unknown>>(), false);
  },
});
