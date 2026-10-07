// 소비자 기대: 정책 하향 뒤 기존 세션은 이미 저장된 조각과 완료 상태를 유지하고 새 예약은 현재 한도로 거부되며, 한도를 복원하면 같은 세션을 이어서 완료한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface SessionCreated {
  sessionId: string;
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
}

export default defineContract({
  id: 'upload-session-policy-change',
  title: 'staging 정책 하향은 기존 세션의 새 조각 예약만 제한하고 정책 복원 뒤 업로드를 이어서 완료한다',
  rq: ['RQ-004', 'RQ-005', 'RQ-008', 'RQ-009', 'RQ-011'],
  profile: 'resumable-upload',
  async run(ctx) {
    const namespaceId = (await ctx.createNamespace()).id;
    const body = Buffer.from('abcdefghij');
    const createBody = {
      path: '/policy-change.bin',
      sizeBytes: String(body.length),
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    };
    const creationKey = randomUUID();
    const created = await ctx.client.createUploadSession(namespaceId, createBody, {
      idempotencyKey: creationKey,
    });
    assert.equal(created.status, 201, created.text());
    const session = created.json<SessionCreated>();
    assert.equal(session.partSizeBytes, 4);
    assert.equal(session.partCount, 3);
    const replay = await ctx.client.createUploadSession(namespaceId, createBody, {
      idempotencyKey: creationKey,
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.json<SessionCreated>().sessionId, session.sessionId);

    for (let index = 0; index < 2; index += 1) {
      const stored = await ctx.client.putUploadPart(
        namespaceId,
        session.sessionId,
        index,
        body.subarray(index * 4, index * 4 + 4),
      );
      assert.equal(stored.status, 200, stored.text());
    }
    await ctx.server.restartWithUploadSessionLimits({
      namespaceId,
      maxStagedBytes: '8',
      partSizeBytes: 2,
    });

    const status = await ctx.client.getUploadSession(namespaceId, session.sessionId);
    assert.equal(status.status, 200);
    const state = status.json<{
      expiresAt: string;
      partSizeBytes: number;
      staging: { maxStagedBytes: string; status: string };
    }>();
    assert.equal(state.partSizeBytes, 4);
    assert.deepEqual(state.staging, { maxStagedBytes: '8', status: 'FILE_TOO_LARGE' });
    const storedReplay = await ctx.client.putUploadPart(
      namespaceId,
      session.sessionId,
      0,
      body.subarray(0, 4),
    );
    assert.equal(storedReplay.status, 200, storedReplay.text());
    assert.equal(storedReplay.json<{ replayed: boolean }>().replayed, true);
    const beforeReject = await ctx.client.getUploadSession(namespaceId, session.sessionId);
    const expiryBeforeReject = beforeReject.json<{ expiresAt: string }>().expiresAt;
    const rejected = await ctx.client.putUploadPart(namespaceId, session.sessionId, 2, body.subarray(8));
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
    assert.equal(
      rejected.json<{ message: string }>().message,
      '파일 크기(10 bytes)가 staging 상한(8 bytes)을 초과함',
    );
    assert.equal(rejected.headers.has('retry-after'), false);
    const afterReject = await ctx.client.getUploadSession(namespaceId, session.sessionId);
    assert.equal(afterReject.json<{ expiresAt: string }>().expiresAt, expiryBeforeReject);

    await ctx.server.restartWithUploadSessionLimits({ namespaceId, maxStagedBytes: '16', partSizeBytes: 2 });
    const resumed = await ctx.client.putUploadPart(namespaceId, session.sessionId, 2, body.subarray(8));
    assert.equal(resumed.status, 200, resumed.text());
    const completed = await ctx.client.completeUploadSession(namespaceId, session.sessionId);
    assert.equal(completed.status, 201, completed.text());
    assert.deepEqual((await ctx.client.getContent(namespaceId, '/policy-change.bin')).bytes, body);

    await ctx.server.restartWithUploadSessionLimits({ namespaceId, maxStagedBytes: '32', partSizeBytes: 4 });
    const allStored = await ctx.client.createUploadSession(namespaceId, {
      ...createBody,
      path: '/policy-lowered-complete.bin',
      sizeBytes: '8',
    });
    assert.equal(allStored.status, 201);
    const completeSession = allStored.json<SessionCreated>();
    assert.equal(completeSession.partSizeBytes, 4);
    assert.equal(completeSession.partCount, 2);
    const firstStored = await ctx.client.putUploadPart(
      namespaceId,
      completeSession.sessionId,
      0,
      Buffer.from('abcd'),
    );
    assert.equal(firstStored.status, 200, firstStored.text());
    const secondStored = await ctx.client.putUploadPart(
      namespaceId,
      completeSession.sessionId,
      1,
      Buffer.from('efgh'),
    );
    assert.equal(secondStored.status, 200, secondStored.text());
    await ctx.server.restartWithUploadSessionLimits({
      namespaceId,
      maxStagedBytes: '4',
      partSizeBytes: 2,
    });
    const completedAboveCap = await ctx.client.completeUploadSession(namespaceId, completeSession.sessionId);
    assert.equal(completedAboveCap.status, 201, completedAboveCap.text());
    assert.deepEqual(
      (await ctx.client.getContent(namespaceId, '/policy-lowered-complete.bin')).bytes,
      Buffer.from('abcdefgh'),
    );

    const smallNamespaceId = (await ctx.createNamespace()).id;
    await ctx.server.restartWithUploadSessionLimits({
      namespaceId: smallNamespaceId,
      maxStagedBytes: '32',
      partSizeBytes: 4,
    });
    const small = await ctx.client.createUploadSession(smallNamespaceId, {
      ...createBody,
      path: '/policy-smaller-than-old-part-size.bin',
      sizeBytes: '3',
    });
    assert.equal(small.status, 201, small.text());
    const smallSession = small.json<SessionCreated>();
    assert.equal(smallSession.partSizeBytes, 4);
    assert.equal(smallSession.partCount, 1);
    await ctx.server.restartWithUploadSessionLimits({
      namespaceId: smallNamespaceId,
      maxStagedBytes: '3',
      partSizeBytes: 2,
    });
    const smallPart = await ctx.client.putUploadPart(
      smallNamespaceId,
      smallSession.sessionId,
      0,
      Buffer.from('xyz'),
    );
    assert.equal(smallPart.status, 200, smallPart.text());
    const smallComplete = await ctx.client.completeUploadSession(smallNamespaceId, smallSession.sessionId);
    assert.equal(smallComplete.status, 201, smallComplete.text());
    assert.deepEqual(
      (await ctx.client.getContent(smallNamespaceId, '/policy-smaller-than-old-part-size.bin')).bytes,
      Buffer.from('xyz'),
    );
  },
});
