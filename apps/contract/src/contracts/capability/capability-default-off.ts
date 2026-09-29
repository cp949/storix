// 소비자 기대: 시작 설정으로 허용하지 않은 선택 capability는 꺼져 있고, 조회 API가 빈 목록을 돌려주며, 그 기능의 요청은 안정적인 코드로 거부되지만 일반 파일 API는 그대로 동작한다.
// 대응 요구사항: RQ-027(선택 capability의 설정과 검색).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'capability-default-off',
  title:
    '설정하지 않은 선택 capability는 꺼져 있고 조회는 빈 목록, 요청은 409 VFS_FEATURE_DISABLED이며 파일 API는 동작한다',
  rq: ['RQ-027'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    const capabilities = await ctx.client.listCapabilities(ns);
    assert.equal(capabilities.status, 200);
    assert.deepEqual(capabilities.json<{ capabilities: string[] }>().capabilities, []);

    // 꺼진 capability의 요청은 코드로 구분되고 메시지에 capability ID가 있다.
    const feed = await ctx.client.listChanges(ns);
    assert.equal(feed.status, 409);
    const error = feed.json<{ code: string; message: string }>();
    assert.equal(error.code, 'VFS_FEATURE_DISABLED');
    assert.ok(error.message.includes('change-feed'), error.message);

    // 기본 파일 API는 capability와 무관하게 동작한다.
    const bytes = Buffer.from('capability 없이도 저장된다', 'utf-8');
    const created = await ctx.client.putConditionalContent(ns, '/doc.txt', bytes, { ifAbsent: true });
    assert.equal(created.status, 201);
    assert.deepEqual((await ctx.client.getContent(ns, '/doc.txt')).bytes, bytes);
  },
});
