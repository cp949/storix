// 소비자 기대: 호출자가 namespace 조회로 적용된 파일 크기 상한과 저장량 상한·사용량을 확인할 수 있고, 저장과 snapshot 생성이 사용량에 반영된다.
// 대응 요구사항: RQ-017(크기 및 저장량 한도). 한도 값은 `small-limits` 프로필(runner/profiles.ts)이 정한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface NamespaceView {
  limits: { maxFileSizeBytes: string };
  quota: { limitBytes: string; usedBytes: string };
}

export default defineContract({
  id: 'limits-visible',
  title:
    'namespace 조회가 적용 파일 상한과 저장량 상한·사용량을 노출하고 저장과 snapshot 생성이 사용량에 반영된다',
  rq: ['RQ-017'],
  profile: 'small-limits',
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const read = async (): Promise<NamespaceView> => {
      const response = await ctx.client.request('GET', `/api/v2/namespaces/${ns}`);
      assert.equal(response.status, 200);
      return response.json<NamespaceView>();
    };

    // 한도는 바이트 단위 10진 문자열이고 아직 아무것도 저장하지 않았으므로 사용량은 0이다.
    const initial = await read();
    assert.equal(initial.limits.maxFileSizeBytes, '1200');
    assert.equal(initial.quota.limitBytes, '2000');
    assert.equal(initial.quota.usedBytes, '0');

    // 파일을 저장하면 논리 크기만큼 사용량이 늘어난다.
    const file = Buffer.alloc(700, 0x61);
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', file, { ifAbsent: true });
    assert.equal(created.status, 201);
    assert.equal((await read()).quota.usedBytes, '700');

    // FILE snapshot은 그 파일 크기를 한 번 더 보유하므로 사용량이 다시 그만큼 늘고, 한도는 그대로다.
    const snapshot = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/doc.txt' });
    assert.equal(snapshot.status, 201);
    const afterSnapshot = await read();
    assert.equal(afterSnapshot.quota.usedBytes, '1400');
    assert.equal(afterSnapshot.quota.limitBytes, '2000');
    assert.equal(afterSnapshot.limits.maxFileSizeBytes, '1200');
  },
});
