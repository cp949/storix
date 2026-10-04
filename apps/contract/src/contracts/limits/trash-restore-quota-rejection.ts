// 소비자 기대: 휴지통을 저장량에서 제외한 namespace에서 복구 결과가 저장량 상한을 넘으면 복구는 한도 유형을 알 수 있는 오류로 거부되고, 휴지통 항목과 사용량은 변하지 않는다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도), RQ-018(안정적인 오류 분류). 한도 값은 `small-limits` 프로필(runner/profiles.ts)이 정한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'trash-restore-quota-rejection',
  title: '저장량 상한을 넘는 휴지통 복구는 413 VFS_QUOTA_EXCEEDED로 거부하고 항목과 사용량을 바꾸지 않는다',
  rq: ['RQ-017', 'RQ-018'],
  profile: 'small-limits',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const settings = await ctx.client.request('PATCH', `/api/v2/admin/namespaces/${ns}/settings`, {
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ trashEnabled: true, excludeTrashFromQuota: true }),
    });
    assert.equal(settings.status, 200, settings.text());
    // 휴지통 제외 설정을 반영한 quota 검사 대상 사용량이다.
    const used = async (): Promise<string> =>
      (await ctx.client.getNamespace(ns)).json<{ quota: { enforcedBytes: string } }>().quota.enforcedBytes;
    const store = async (path: string, fill: number): Promise<void> => {
      const response = await ctx.client.putConditionalContent(ns, path, Buffer.alloc(700, fill), {
        ifAbsent: true,
      });
      assert.equal(response.status, 201, response.text());
    };

    // 삭제한 파일은 휴지통 제외 설정이라 사용량에서 빠지므로 700바이트 파일 두 개를 더 저장할 수 있다.
    await store('/gone.bin', 0x61);
    const revision = (await ctx.client.getStat(ns, '/gone.bin')).json<{ revision: string }>().revision;
    const deleted = await ctx.client.postMutation(ns, {
      kind: 'delete',
      path: '/gone.bin',
      ifRevision: revision,
      recursive: false,
    });
    assert.equal(deleted.status, 200, deleted.text());
    const trashId = deleted.json<{ trashId: string }>().trashId;
    assert.equal(await used(), '0');
    await store('/b.bin', 0x62);
    await store('/c.bin', 0x63);
    assert.equal(await used(), '1400');

    // 복구하면 2100이 되어 상한(2000)을 넘으므로 거부되고, 항목은 남고 경로는 생기지 않는다.
    const rejected = await ctx.client.restoreTrash(ns, trashId, {});
    assert.equal(rejected.status, 413, rejected.text());
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_QUOTA_EXCEEDED');
    assert.equal((await ctx.client.getStat(ns, '/gone.bin')).status, 404);
    assert.equal(await used(), '1400');
    const items = (await ctx.client.listTrash(ns)).json<{ items: Array<{ trashId: string }> }>().items;
    assert.deepEqual(
      items.map((item) => item.trashId),
      [trashId],
    );
  },
});
