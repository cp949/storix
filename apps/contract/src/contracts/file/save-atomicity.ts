// 소비자 기대: 저장이 실패하거나 중단되면 기존 파일의 바이트와 revision이 그대로이고, 새 경로에는 부분 파일이 생기지 않는다.
// 대응 요구사항: RQ-009(원자적 파일 저장). 한도 초과 롤백은 한도 프로필 계약이 맡는다.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { defineContract } from '../../define-contract.ts';
import type { ContractContext } from '../../define-contract.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface ConditionalResult {
  resource: { revision: string };
}

interface Stat {
  revision: string;
  updatedAt: string;
  size: number;
}

/** 선언한 길이보다 적게 보낸 뒤 연결을 끊어 업로드를 중단한다. 서버가 요청을 끝낼 때까지 기다리지 않는다. */
function abortUpload(
  ctx: ContractContext,
  namespaceId: string,
  filePath: string,
  condition: Readonly<Record<string, string>>,
  declaredBytes: number,
  sent: Buffer,
): Promise<void> {
  const url = new URL(
    `${ctx.baseUrl}/api/v2/namespaces/${namespaceId}/fs/content/conditional?path=${encodeURIComponent(filePath)}`,
  );
  return new Promise((resolve) => {
    const request = http.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        'Idempotency-Key': randomUUID(),
        'X-Mutation-Scope': 'storix-contract',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(declaredBytes),
        ...condition,
      },
    });
    request.on('error', () => resolve());
    request.on('close', () => resolve());
    request.write(sent, () => request.destroy());
  });
}

export default defineContract({
  id: 'save-atomicity',
  title: '검증 실패·업로드 중단 시 기존 파일과 revision이 유지되고 새 경로에 부분 파일이 없다',
  rq: ['RQ-009'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const original = Buffer.from('온전한 기존 본문', 'utf-8');
    const attempted = Buffer.alloc(512 * 1024, 7);

    const created = await ctx.client.putConditionalContent(ns, '/doc.bin', original, { ifAbsent: true });
    const v1 = created.json<ConditionalResult>().resource;
    const before = (await ctx.client.getStat(ns, '/doc.bin')).json<Stat>();

    // checksum이 맞지 않으면 교체를 반영하지 않는다.
    const wrongChecksum = sha256(Buffer.from('다른 바이트'));
    const mismatch = await ctx.client.putConditionalContent(
      ns,
      '/doc.bin',
      attempted,
      { ifRevision: v1.revision },
      { expectedSha256: wrongChecksum },
    );
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.json<{ code: string }>().code, 'VFS_CHECKSUM_MISMATCH');
    const afterMismatch = await ctx.client.getContent(ns, '/doc.bin');
    assert.deepEqual(afterMismatch.bytes, original);
    assert.equal(afterMismatch.headers.get('x-storix-revision'), v1.revision);
    assert.deepEqual((await ctx.client.getStat(ns, '/doc.bin')).json<Stat>(), before);

    // 새 경로 생성이 checksum으로 실패하면 파일이 생기지 않는다.
    const createMismatch = await ctx.client.putConditionalContent(
      ns,
      '/never.bin',
      attempted,
      { ifAbsent: true },
      { expectedSha256: wrongChecksum },
    );
    assert.equal(createMismatch.status, 422);
    assert.equal((await ctx.client.getStat(ns, '/never.bin')).status, 404);

    // 교체 업로드가 중간에 끊겨도 기존 파일과 revision을 유지한다.
    const partial = attempted.subarray(0, 64 * 1024);
    await abortUpload(ctx, ns, '/doc.bin', { 'X-If-Revision': v1.revision }, attempted.length, partial);
    const afterAbort = await ctx.client.getContent(ns, '/doc.bin');
    assert.deepEqual(afterAbort.bytes, original);
    assert.equal(afterAbort.headers.get('x-storix-revision'), v1.revision);

    // 새 경로 생성 업로드가 끊겨도 파일이 생기지 않는다.
    await abortUpload(ctx, ns, '/interrupted.bin', { 'X-If-Absent': 'true' }, attempted.length, partial);
    assert.equal((await ctx.client.getStat(ns, '/interrupted.bin')).status, 404);

    // 실패가 상태를 바꾸지 않았으므로 같은 revision으로 다시 저장하면 성공하고 전체를 읽을 수 있다.
    const retried = await ctx.client.putConditionalContent(ns, '/doc.bin', attempted, {
      ifRevision: v1.revision,
    });
    assert.equal(retried.status, 200);
    const afterRetry = await ctx.client.getContent(ns, '/doc.bin');
    assert.deepEqual(afterRetry.bytes, attempted);
    assert.notEqual(afterRetry.headers.get('x-storix-revision'), v1.revision);
    assert.equal(afterRetry.headers.get('x-storix-sha256'), sha256(attempted));
  },
});
