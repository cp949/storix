// 소비자 기대: 업로드 세션 생성도 `Idempotency-Key`·`X-Mutation-Scope`가 없거나 틀리면 400 `VFS_INVALID_MUTATION_REQUEST`로 거부되고 receipt를 남기지 않아, 헤더를 고친 같은 key의 재요청은 정상 처리된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성: fingerprint 이전 오류는 receipt 없이 재평가), RQ-018(안정적인 오류 분류). 다른 변경 요청의 헤더 오류는 `mutation-header-validation`·`mutation-header-validation-lifecycle`이 다룬다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

/** 정상 헤더에서 한 가지씩 빼거나 망가뜨린 경우. `null`은 헤더를 보내지 않는다. */
const BAD_HEADERS: ReadonlyArray<{ name: string; key: string | null; scope: string | null }> = [
  { name: 'key 없음', key: null, scope: 'contract' },
  { name: 'scope 없음', key: randomUUID(), scope: null },
  { name: 'key가 UUID가 아님', key: 'not-a-uuid', scope: 'contract' },
  { name: 'key가 빈 값', key: '', scope: 'contract' },
  { name: 'scope가 빈 값', key: randomUUID(), scope: '' },
  { name: 'scope가 129바이트', key: randomUUID(), scope: 'a'.repeat(129) },
];

export default defineContract({
  id: 'mutation-header-validation-upload-session',
  title:
    '업로드 세션 생성의 Idempotency-Key·X-Mutation-Scope 오류는 400 VFS_INVALID_MUTATION_REQUEST로 거부하고 receipt를 남기지 않아 헤더를 고친 재요청이 처리된다',
  rq: ['RQ-011', 'RQ-018'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const url = `/api/v2/namespaces/${ns}/fs/upload-sessions`;
    const body = JSON.stringify({
      path: '/doc.bin',
      sizeBytes: '4',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    });

    for (const bad of BAD_HEADERS) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (bad.key !== null) headers['Idempotency-Key'] = bad.key;
      if (bad.scope !== null) headers['X-Mutation-Scope'] = bad.scope;
      const response = await ctx.client.request('POST', url, { headers, body });
      assert.equal(response.status, 400, `${bad.name}: ${response.text()}`);
      assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_MUTATION_REQUEST', bad.name);
    }
    assert.equal((await ctx.client.getStat(ns, '/doc.bin')).status, 404);

    // 같은 key를 scope만 고쳐 다시 보내면 앞의 400이 receipt로 남지 않았으므로 새로 처리된다.
    const key = randomUUID();
    const rejected = await ctx.client.request('POST', url, {
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Mutation-Scope': '' },
      body,
    });
    assert.equal(rejected.status, 400);
    const fixed = await ctx.client.request('POST', url, {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        // 경계값(128바이트)은 통과한다.
        'X-Mutation-Scope': 'a'.repeat(128),
      },
      body,
    });
    assert.equal(fixed.status, 201, fixed.text());
    assert.equal(fixed.json<{ state: string }>().state, 'OPEN');
  },
});
