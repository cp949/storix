// 소비자 기대: 관리자 quota 변경은 `maxTotalLogicalBytes` 외 필드가 있으면 400으로 거부하고 상한을 바꾸지 않는다. 사용량보다 낮은 상한은 받아들이되 저장된 파일은 그대로 두고 새 저장만 413으로 막는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류). 전역 한도는 `small-limits` 프로필(runner/profiles.ts)이 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface NamespaceView {
  quota: { limitBytes: string; usedBytes: string };
}

export default defineContract({
  id: 'namespace-quota-request-shape',
  title:
    'quota 변경은 추가 필드를 400으로 거부하고 상한을 유지하며, 사용량보다 낮은 상한은 받아들여 새 저장만 413으로 막는다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const quotaOf = async (): Promise<NamespaceView['quota']> => {
      const response = await ctx.client.getNamespace(ns);
      assert.equal(response.status, 200, response.text());
      return response.json<NamespaceView>().quota;
    };

    const bytes = Buffer.alloc(600, 0x61);
    const stored = await ctx.client.putConditionalContent(ns, '/a.bin', bytes, { ifAbsent: true });
    assert.equal(stored.status, 201);
    const revision = stored.json<{ resource: { revision: string } }>().resource.revision;

    // 추가 필드가 하나라도 있으면 400이고 상한은 전역 상한(2000) 그대로다.
    for (const body of [
      { maxTotalLogicalBytes: '1000', extra: 1 },
      { maxTotalLogicalBytes: null, limitBytes: '1' },
    ]) {
      const rejected = await ctx.client.updateNamespaceQuota(ns, ctx.adminKey, body);
      assert.equal(rejected.status, 400, rejected.text());
      assert.equal(rejected.json<{ code: string }>().code, 'NAMESPACE_INVALID_TOTAL_LOGICAL_BYTES');
      assert.equal((await quotaOf()).limitBytes, '2000');
    }

    // 사용량(600)보다 낮은 상한(500)도 받아들인다. 응답과 조회가 새 상한과 그대로인 사용량을 알린다.
    const lowered = await ctx.client.updateNamespaceQuota(ns, ctx.adminKey, { maxTotalLogicalBytes: '500' });
    assert.equal(lowered.status, 200, lowered.text());
    assert.deepEqual(
      { limit: lowered.json<NamespaceView>().quota.limitBytes, used: (await quotaOf()).usedBytes },
      { limit: '500', used: '600' },
    );

    // 저장된 파일은 그대로 읽히고, 사용량이 상한을 넘은 동안 새 저장은 1바이트도 413이다.
    assert.deepEqual((await ctx.client.getContent(ns, '/a.bin')).bytes, bytes);
    const rejectedWrite = await ctx.client.putConditionalContent(ns, '/b.bin', Buffer.from('x'), {
      ifAbsent: true,
    });
    assert.equal(rejectedWrite.status, 413);
    assert.equal(rejectedWrite.json<{ code: string }>().code, 'VFS_QUOTA_EXCEEDED');
    assert.equal((await ctx.client.getStat(ns, '/b.bin')).status, 404);

    // 파일을 지우면 사용량이 상한 아래로 내려오고, 새 저장은 낮춘 상한(500) 안에서만 허용된다.
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/a.bin',
      ifRevision: revision,
    });
    assert.equal(deleted.status, 200, deleted.text());
    assert.equal((await quotaOf()).usedBytes, '0');
    const tooLarge = await ctx.client.putConditionalContent(ns, '/c.bin', Buffer.alloc(600, 0x63), {
      ifAbsent: true,
    });
    assert.equal(tooLarge.status, 413);
    const fits = await ctx.client.putConditionalContent(ns, '/c.bin', Buffer.alloc(400, 0x63), {
      ifAbsent: true,
    });
    assert.equal(fits.status, 201, fits.text());
  },
});
