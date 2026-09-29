// 소비자 기대: 관리자가 namespace 저장량 상한을 전역 상한 이하로 바꾸면 그 namespace에만 적용되고, null로 되돌리면 전역 상한을 다시 따른다. 전역 상한을 넘는 값은 거부된다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도). 전역 한도는 `small-limits` 프로필(runner/profiles.ts)이 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';
import type { ContractContext } from '../../define-contract.ts';

interface NamespaceView {
  quota: { limitBytes: string; usedBytes: string };
}

/** namespace 조회로 적용 중인 저장량 상한과 사용량을 읽는다. */
async function readQuota(ctx: ContractContext, ns: string): Promise<NamespaceView['quota']> {
  const response = await ctx.client.getNamespace(ns);
  assert.equal(response.status, 200, response.text());
  return response.json<NamespaceView>().quota;
}

export default defineContract({
  id: 'namespace-quota-override',
  title:
    'namespace 저장량 상한을 전역 이하로 재정의하면 그 namespace에만 적용되고 null로 전역 상한을 상속하며 전역 초과는 거부한다',
  rq: ['RQ-017'],
  profile: 'small-limits',
  async run(ctx) {
    const target = (await ctx.createNamespace()).id;
    const other = (await ctx.createNamespace()).id;
    assert.equal((await readQuota(ctx, target)).limitBytes, '2000');

    // 상한을 1000으로 줄이면 응답과 조회가 새 값을 알리고 다른 namespace는 전역 상한 그대로다.
    const lowered = await ctx.client.updateNamespaceQuota(target, ctx.adminKey, {
      maxTotalLogicalBytes: '1000',
    });
    assert.equal(lowered.status, 200, lowered.text());
    assert.equal(lowered.json<NamespaceView>().quota.limitBytes, '1000');
    assert.equal((await readQuota(ctx, target)).limitBytes, '1000');
    assert.equal((await readQuota(ctx, other)).limitBytes, '2000');

    // 줄인 상한이 저장을 막는다. 600바이트 하나는 들어가고 두 번째는 합계 1200이라 거부되며 상태가 그대로다.
    const first = Buffer.alloc(600, 0x61);
    assert.equal(
      (await ctx.client.putConditionalContent(target, '/a.bin', first, { ifAbsent: true })).status,
      201,
    );
    const rejected = await ctx.client.putConditionalContent(target, '/b.bin', Buffer.alloc(600, 0x62), {
      ifAbsent: true,
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_QUOTA_EXCEEDED');
    assert.equal((await ctx.client.getStat(target, '/b.bin')).status, 404);
    assert.equal((await readQuota(ctx, target)).usedBytes, '600');

    // 같은 크기의 저장이 상한을 재정의하지 않은 namespace에서는 두 번 다 성공한다.
    for (const name of ['a', 'b']) {
      const stored = await ctx.client.putConditionalContent(other, `/${name}.bin`, Buffer.alloc(600, 0x63), {
        ifAbsent: true,
      });
      assert.equal(stored.status, 201, name);
    }

    // 전역 상한(2000)을 넘는 값은 거부하고 기존 상한을 바꾸지 않는다. 전역 상한과 같은 값은 허용한다.
    const above = await ctx.client.updateNamespaceQuota(target, ctx.adminKey, {
      maxTotalLogicalBytes: '2001',
    });
    assert.equal(above.status, 400, above.text());
    assert.equal(above.json<{ code: string }>().code, 'NAMESPACE_QUOTA_LIMIT_EXCEEDS_GLOBAL');
    assert.equal((await readQuota(ctx, target)).limitBytes, '1000');
    const equal = await ctx.client.updateNamespaceQuota(other, ctx.adminKey, {
      maxTotalLogicalBytes: '2000',
    });
    assert.equal(equal.status, 200, equal.text());
    assert.equal((await readQuota(ctx, other)).limitBytes, '2000');

    // null로 되돌리면 전역 상한을 다시 따르므로 앞서 거부된 저장이 성공한다.
    const inherited = await ctx.client.updateNamespaceQuota(target, ctx.adminKey, {
      maxTotalLogicalBytes: null,
    });
    assert.equal(inherited.status, 200, inherited.text());
    assert.equal(inherited.json<NamespaceView>().quota.limitBytes, '2000');
    const retried = await ctx.client.putConditionalContent(target, '/b.bin', Buffer.alloc(600, 0x62), {
      ifAbsent: true,
    });
    assert.equal(retried.status, 201, retried.text());
    assert.equal((await readQuota(ctx, target)).usedBytes, '1200');
  },
});
