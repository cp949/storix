// 새 세션은 유효 staging 상한을 넘는 파일 크기를 저장 없이 거절하고 거절된 key를 점유하지 않는다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface UploadSessions {
  /** namespace에 적용하는 staging 바이트 상한. */
  maxStagedBytes: string;

  /** namespace의 현재 staging 사용량. */
  stagedBytes: string;

  /** namespace의 활성 세션 수. */
  activeSessions: number;
}

export default defineContract({
  id: 'upload-session-staging-file-size',
  title: '새 업로드 세션은 유효 staging 파일 크기 상한을 적용하고 거절은 상태를 바꾸지 않는다',
  rq: ['RQ-018', 'RQ-027'],
  profile: 'resumable-upload',
  async run(ctx) {
    const namespaceId = (await ctx.createNamespace()).id;
    const readUsage = async (): Promise<UploadSessions> => {
      const response = await ctx.client.getNamespace(namespaceId);
      assert.equal(response.status, 200, response.text());
      const body = response.json<{ uploadSessions?: UploadSessions }>();
      assert.ok(body.uploadSessions, 'uploadSessions 블록이 없다');
      return body.uploadSessions;
    };
    const create = (sizeBytes: string, path: string, idempotencyKey: string) =>
      ctx.client.createUploadSession(
        namespaceId,
        { path, sizeBytes, mimeType: 'application/octet-stream', ifAbsent: true },
        { idempotencyKey },
      );

    const initial = await readUsage();
    const cap = BigInt(initial.maxStagedBytes);
    assert.equal(cap, 1048576n, 'resumable-upload profile staging 상한');
    assert.equal(initial.stagedBytes, '0');
    assert.equal(initial.activeSessions, 0);

    for (const size of [String(cap - 1n), String(cap), '0']) {
      const created = await create(size, `/staging-admission-${size}.bin`, randomUUID());
      assert.equal(created.status, 201, created.text());
    }
    const afterAccepted = await readUsage();
    assert.equal(afterAccepted.activeSessions, initial.activeSessions + 3);
    assert.equal(afterAccepted.stagedBytes, initial.stagedBytes);

    const retryKey = randomUUID();
    const rejected = await create(String(cap + 1n), '/staging-admission-retry.bin', retryKey);
    assert.equal(rejected.status, 413, rejected.text());
    const error = rejected.json<{ code: string; message: string; requestId: string }>();
    assert.equal(error.code, 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
    assert.match(error.message, /1048577 bytes.*1048576 bytes/);
    assert.ok(error.requestId.length > 0);
    assert.equal(rejected.headers.has('retry-after'), false);
    assert.deepEqual(await readUsage(), afterAccepted);

    const retried = await create('1', '/staging-admission-retry.bin', retryKey);
    assert.equal(retried.status, 201, retried.text());
    const afterRetry = await readUsage();
    assert.equal(afterRetry.activeSessions, afterAccepted.activeSessions + 1);
    assert.equal(afterRetry.stagedBytes, afterAccepted.stagedBytes);

    await ctx.client.mkdir(namespaceId, '/staging-directory');
    for (const path of ['/staging-directory', '/staging-missing/child.bin']) {
      const oversized = await create(String(cap + 1n), path, randomUUID());
      assert.equal(oversized.status, 413, `${path}: ${oversized.text()}`);
      assert.equal(oversized.json<{ code: string }>().code, 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
    }
    const afterPathRejections = await readUsage();
    assert.equal(afterPathRejections.activeSessions, afterRetry.activeSessions);
    assert.equal(afterPathRejections.stagedBytes, afterRetry.stagedBytes);
  },
});
