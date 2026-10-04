// 소비자 기대: namespace가 담을 수 있는 live 노드 수 상한을 넘는 생성·복사는 한도 유형을 알 수 있는 오류로 거부되고 아무것도 바뀌지 않는다. 기존 파일 교체는 상한에 걸리지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';

export default defineContract({
  id: 'namespace-node-limit-rejection',
  title:
    'namespace live 노드 수 상한을 넘는 생성·복사는 413 VFS_NAMESPACE_NODE_LIMIT_EXCEEDED로 거부하고 무변경이다',
  rq: ['RQ-017', 'RQ-018'],
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const settings = await ctx.client.request('PATCH', `/api/v2/admin/namespaces/${ns}/settings`, {
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ maxNodes: '3' }),
    });
    assert.equal(settings.status, 200, settings.text());

    const revisionOf = async (path: string): Promise<string> =>
      (await ctx.client.getStat(ns, path)).json<{ revision: string }>().revision;
    const assertNodeLimit = (response: ApiResponse, label: string): void => {
      assert.equal(response.status, 413, `${label}: ${response.text()}`);
      assert.equal(response.json<{ code: string }>().code, 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED', label);
    };

    // root는 세지 않으므로 파일 세 개까지 만들어지고 네 번째가 상한을 넘는다.
    const created = ['/n0.txt', '/n1.txt', '/n2.txt'];
    for (const path of created) {
      const response = await ctx.client.putConditionalContent(ns, path, Buffer.from(path, 'utf-8'), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, response.text());
    }
    assertNodeLimit(
      await ctx.client.putConditionalContent(ns, '/n3.txt', Buffer.from('n3', 'utf-8'), { ifAbsent: true }),
      '조건부 저장',
    );

    // 같은 상태에서 다른 생성 경로도 모두 거부되고 경로가 생기지 않는다.
    assertNodeLimit(await ctx.client.mkdir(ns, '/dir'), 'mkdir');
    assertNodeLimit(await ctx.client.mkdir(ns, '/p/q', true), 'mkdir parents');
    assertNodeLimit(
      await ctx.client.request('POST', `/api/v2/namespaces/${ns}/fs/touch`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/touched.txt' }),
      }),
      'touch',
    );
    assertNodeLimit(await ctx.client.copy(ns, { source: created[0], destination: '/copied.txt' }), 'cp');
    assertNodeLimit(
      await ctx.client.postMutation(ns, {
        kind: 'mkdir',
        path: '/dir',
        ifAbsent: true,
      }),
      'mutations mkdir',
    );
    for (const path of ['/dir', '/n3.txt', '/p', '/touched.txt', '/copied.txt']) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 404, `${path}가 생기면 안 된다`);
    }

    // 기존 파일 교체는 노드를 늘리지 않으므로 상한에 걸리지 않는다.
    const replaced = await ctx.client.putConditionalContent(ns, created[0], Buffer.from('교체', 'utf-8'), {
      ifRevision: await revisionOf(created[0]),
    });
    assert.equal(replaced.status, 200, replaced.text());
  },
});
