// 소비자 기대: prefix namespace ID는 생성·재생·조회·파일 접근에서 대소문자까지 정확히 유지된다.
// 대응 요구사항: RQ-002(namespace 격리).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-id-prefix',
  title: '최대 길이 prefix namespace ID를 VFS·capability·resumable upload·삭제 경로에 사용할 수 있다',
  rq: ['RQ-002'],
  profile: 'resumable-upload-prefix',
  async run(ctx) {
    const key = randomUUID();
    const body = JSON.stringify({ name: `prefix-${randomUUID()}`, idPrefix: 'abcdefghijkl' });
    const first = await ctx.client.request('POST', '/api/v2/namespaces', {
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(first.status, 201, first.text());
    const created = first.json<{ id: string }>();
    assert.equal(created.id.length, 45);
    assert.match(created.id, /^abcdefghijkl_[0-9a-f]{32}$/);

    const replay = await ctx.client.request('POST', '/api/v2/namespaces', {
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(replay.status, 201, replay.text());
    assert.deepEqual(replay.json(), created);

    assert.equal((await ctx.client.getNamespace(created.id)).status, 200);
    const file = await ctx.client.putConditionalContent(
      created.id,
      '/prefix.txt',
      Buffer.from('prefix namespace'),
      { ifAbsent: true },
    );
    assert.equal(file.status, 201, file.text());
    assert.equal((await ctx.client.getContent(created.id, '/prefix.txt')).status, 200);

    const capableNamespace = await ctx.createNamespace();
    assert.equal(capableNamespace.id.length, 45);
    assert.match(capableNamespace.id, /^abcdefghijkl_[0-9a-f]{32}$/);
    const capabilities = await ctx.client.listCapabilities(capableNamespace.id);
    assert.equal(capabilities.status, 200, capabilities.text());
    assert.ok(JSON.stringify(capabilities.json()).includes('resumable-upload'));

    const upload = await ctx.client.createUploadSession(capableNamespace.id, {
      path: '/resumable.txt',
      sizeBytes: '1',
      mimeType: 'text/plain',
      ifAbsent: true,
    });
    assert.equal(upload.status, 201, upload.text());
    const session = upload.json<{ sessionId: string }>();
    const cancelled = await ctx.client.cancelUploadSession(capableNamespace.id, session.sessionId);
    assert.equal(cancelled.status, 200, cancelled.text());

    const deletion = await ctx.client.deleteNamespace(capableNamespace.id, ctx.adminKey);
    assert.equal(deletion.status, 202, deletion.text());
    assert.equal((await ctx.client.getNamespaceDeletion(capableNamespace.id, ctx.adminKey)).status, 200);
  },
});
