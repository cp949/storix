// 소비자 기대: 허용한 namespace에서만 선택 capability가 켜지고, 조회 API로 활성 ID를 확인할 수 있으며, 허용하지 않은 namespace는 꺼진 채 요청이 거부되지만 파일 API는 동작한다.
// 대응 요구사항: RQ-027(선택 capability의 설정과 검색). 프로필 `change-feed`가 전역과 사전 준비 namespace에 `change-feed`를 허용한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'capability-discovery',
  title:
    '허용한 namespace는 활성 capability를 조회하고 feed가 열리며, 허용하지 않은 namespace는 꺼진 채 409로 거부된다',
  rq: ['RQ-027'],
  profile: 'change-feed',
  async run(ctx) {
    const enabled = await ctx.createNamespace();
    const disabled = await ctx.createNamespace({ withoutCapabilities: true });
    assert.notEqual(enabled.id, disabled.id);

    // 허용한 namespace: 활성 ID가 조회되고 feed가 열린다.
    const enabledList = await ctx.client.listCapabilities(enabled.id);
    assert.equal(enabledList.status, 200);
    assert.deepEqual(enabledList.json<{ capabilities: string[] }>().capabilities, ['change-feed']);
    assert.equal((await ctx.client.listChanges(enabled.id)).status, 200);

    // 허용하지 않은 namespace: 전역에서 허용했더라도 namespace 허용이 없으면 꺼져 있다.
    const disabledList = await ctx.client.listCapabilities(disabled.id);
    assert.equal(disabledList.status, 200);
    assert.deepEqual(disabledList.json<{ capabilities: string[] }>().capabilities, []);
    const rejected = await ctx.client.listChanges(disabled.id);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_FEATURE_DISABLED');

    // 꺼진 namespace에서도 일반 파일 API는 동작한다.
    const bytes = Buffer.from('꺼진 namespace의 파일', 'utf-8');
    const created = await ctx.client.putConditionalContent(disabled.id, '/doc.txt', bytes, {
      ifAbsent: true,
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await ctx.client.getContent(disabled.id, '/doc.txt')).bytes, bytes);
  },
});
