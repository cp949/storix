// 소비자 기대: 유효한 서비스 API key만 파일 요청을 처리하고, key가 없거나 틀리면 파일 존재 여부와 본문을 알리지 않고 거부한다.
// 대응 요구사항: RQ-001(호출 서버 인증).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const SECRET = '인증 없이는 읽히면 안 되는 본문';

export default defineContract({
  id: 'api-key-required',
  title: '유효한 API key만 허용하고, 누락·오류 key는 존재 여부와 본문 없이 401로 거부한다',
  rq: ['RQ-001'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const created = await ctx.client.putConditionalContent(
      namespace.id,
      '/secret.txt',
      Buffer.from(SECRET, 'utf-8'),
      { ifAbsent: true },
    );
    assert.equal(created.status, 201);

    const readPath = (filePath: string) =>
      `/api/v2/namespaces/${namespace.id}/fs/content?path=${encodeURIComponent(filePath)}`;
    const withoutKey = (path: string, authorization?: string) =>
      fetch(`${ctx.baseUrl}${path}`, {
        signal: ctx.signal,
        ...(authorization === undefined ? {} : { headers: { Authorization: authorization } }),
      });

    // 자격이 유효하지 않은 세 경우(헤더 없음, 잘못된 key, Bearer가 아닌 방식)는 같은 방식으로 거부된다.
    const rejected = [
      await withoutKey(readPath('/secret.txt')),
      await withoutKey(readPath('/secret.txt'), 'Bearer not-the-service-key'),
      await withoutKey(readPath('/secret.txt'), 'Basic c3Rvcml4OnN0b3JpeA=='),
    ];
    const rejectedCodes: string[] = [];
    for (const response of rejected) {
      assert.equal(response.status, 401);
      const text = await response.text();
      assert.ok(!text.includes(SECRET), '거부 응답에 본문이 없어야 한다');
      rejectedCodes.push((JSON.parse(text) as { code: string }).code);
    }

    // 있는 파일과 없는 파일에 대한 거부 응답이 구분되지 않는다.
    const missing = await withoutKey(readPath('/never-created.txt'));
    assert.equal(missing.status, 401);
    assert.equal((JSON.parse(await missing.text()) as { code: string }).code, rejectedCodes[0]);

    // 인증 없는 변경 요청은 거부되고 파일을 만들지 않는다.
    const forged = await fetch(
      `${ctx.baseUrl}/api/v2/namespaces/${namespace.id}/fs/content/conditional?path=${encodeURIComponent('/forged.txt')}`,
      {
        signal: ctx.signal,
        method: 'POST',
        headers: {
          'Idempotency-Key': randomUUID(),
          'X-Mutation-Scope': 'storix-contract',
          'X-If-Absent': 'true',
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('forged'),
      },
    );
    assert.equal(forged.status, 401);
    assert.equal((await ctx.client.getStat(namespace.id, '/forged.txt')).status, 404);

    // 유효한 key로는 같은 요청이 성공한다.
    const allowed = await ctx.client.getContent(namespace.id, '/secret.txt');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.text(), SECRET);
  },
});
