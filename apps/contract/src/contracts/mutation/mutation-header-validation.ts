// 소비자 기대: 변경 요청의 `Idempotency-Key`·`X-Mutation-Scope`가 없거나 형식이 틀리면 400 `VFS_INVALID_MUTATION_REQUEST`로 거부되고 아무것도 바뀌지 않으며, 헤더를 고쳐 다시 보내면 정상 처리된다.
// 대응 요구사항: RQ-011(변경 요청의 멱등성: fingerprint 이전 오류는 receipt 없이 재평가), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

/** 정상 헤더에서 한 가지씩 빼거나 망가뜨린 경우. `null`은 헤더를 보내지 않는다. */
const BAD_HEADERS: ReadonlyArray<{ name: string; key: string | null; scope: string | null }> = [
  { name: 'key 없음', key: null, scope: 'contract' },
  { name: 'scope 없음', key: randomUUID(), scope: null },
  { name: 'key가 UUID가 아님', key: 'not-a-uuid', scope: 'contract' },
  { name: 'key가 빈 값', key: '', scope: 'contract' },
  { name: 'scope가 빈 값', key: randomUUID(), scope: '' },
  { name: 'scope가 129바이트', key: randomUUID(), scope: 'a'.repeat(129) },
];

function headersOf(
  bad: { key: string | null; scope: string | null },
  extra: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (bad.key !== null) headers['Idempotency-Key'] = bad.key;
  if (bad.scope !== null) headers['X-Mutation-Scope'] = bad.scope;
  return headers;
}

function assertHeaderRejected(response: ApiResponse, label: string): void {
  assert.equal(response.status, 400, `${label}: ${response.text()}`);
  assert.equal(response.json<{ code: string }>().code, 'VFS_INVALID_MUTATION_REQUEST', label);
}

export default defineContract({
  id: 'mutation-header-validation',
  title:
    '변경 요청의 Idempotency-Key·X-Mutation-Scope 누락·형식 오류는 400 VFS_INVALID_MUTATION_REQUEST로 거부하고 상태를 바꾸지 않는다',
  rq: ['RQ-011', 'RQ-018'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const fs = `/api/v2/namespaces/${ns}/fs`;
    const validKey = (): Record<string, string> => ({
      'Idempotency-Key': randomUUID(),
      'X-Mutation-Scope': 'contract',
    });

    // 대상 파일을 하나 만들어 snapshot 요청의 원본으로 쓴다.
    const seed = await ctx.client.putConditionalContent(ns, '/seed.txt', Buffer.from('씨앗'), {
      ifAbsent: true,
    });
    assert.equal(seed.status, 201);
    const seedId = seed.json<{ resource: { id: string } }>().resource.id;

    // 조건부 저장: 잘못된 헤더는 400이고 경로가 생기지 않는다.
    for (const bad of BAD_HEADERS) {
      const response = await ctx.client.request('POST', `${fs}/content/conditional?path=%2Fbad.txt`, {
        headers: headersOf(bad, { 'X-If-Absent': 'true', 'Content-Type': 'application/octet-stream' }),
        body: Buffer.from('x'),
      });
      assertHeaderRejected(response, `content/conditional ${bad.name}`);
    }
    assert.equal((await ctx.client.getStat(ns, '/bad.txt')).status, 404);

    // 조건부 mutation
    const mkdirBody = JSON.stringify({ kind: 'mkdir', path: '/bad-dir', ifAbsent: true });
    for (const bad of BAD_HEADERS) {
      const response = await ctx.client.request('POST', `${fs}/mutations`, {
        headers: headersOf(bad, { 'Content-Type': 'application/json' }),
        body: mkdirBody,
      });
      assertHeaderRejected(response, `mutations ${bad.name}`);
    }
    assert.equal((await ctx.client.getStat(ns, '/bad-dir')).status, 404);

    // snapshot 생성
    const snapshotBody = JSON.stringify({ kind: 'file', path: '/seed.txt' });
    for (const bad of BAD_HEADERS) {
      const response = await ctx.client.request('POST', `${fs}/snapshots`, {
        headers: headersOf(bad, { 'Content-Type': 'application/json' }),
        body: snapshotBody,
      });
      assertHeaderRejected(response, `snapshots ${bad.name}`);
    }
    const snapshots = await ctx.client.listSnapshots(ns, seedId);
    assert.equal(snapshots.status, 200);
    assert.deepEqual(snapshots.json<{ items: unknown[] }>().items, []);

    // 헤더를 고쳐 다시 보내면 receipt가 남지 않았으므로 정상 처리된다. scope 128바이트는 경계 안이다.
    const boundaryScope = 'a'.repeat(128);
    const stored = await ctx.client.request('POST', `${fs}/content/conditional?path=%2Fbad.txt`, {
      headers: {
        'Idempotency-Key': randomUUID(),
        'X-Mutation-Scope': boundaryScope,
        'X-If-Absent': 'true',
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from('x'),
    });
    assert.equal(stored.status, 201, stored.text());
    const mkdir = await ctx.client.request('POST', `${fs}/mutations`, {
      headers: { ...validKey(), 'Content-Type': 'application/json' },
      body: mkdirBody,
    });
    assert.equal(mkdir.status, 201, mkdir.text());
    const snapshot = await ctx.client.request('POST', `${fs}/snapshots`, {
      headers: { ...validKey(), 'Content-Type': 'application/json' },
      body: snapshotBody,
    });
    assert.equal(snapshot.status, 201, snapshot.text());
  },
});
