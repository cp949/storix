// 소비자 기대: 재개 업로드는 선택 capability라서 허용한 namespace에서만 세션을 만들 수 있고, 허용하지 않은 namespace는 활성 목록에 없고 세션 생성이 409 `VFS_FEATURE_DISABLED`이며 일반 파일 API는 그대로 동작한다.
// 대응 요구사항: RQ-027(선택 capability의 설정과 검색).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'upload-session-capability',
  title:
    '재개 업로드는 허용한 namespace에서만 열리고, 허용하지 않은 namespace는 목록에 없고 세션 생성이 409로 거부되며 파일 API는 동작한다',
  rq: ['RQ-027'],
  profile: 'resumable-upload',
  async run(ctx) {
    const enabled = (await ctx.createNamespace()).id;
    const disabled = (await ctx.createNamespace({ withoutCapabilities: true })).id;
    const body = {
      path: '/gated.bin',
      sizeBytes: '4',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    };

    // 허용한 namespace만 활성 목록에 `resumable-upload`가 있고 세션이 열린다.
    const enabledList = await ctx.client.listCapabilities(enabled);
    assert.equal(enabledList.status, 200);
    assert.deepEqual(enabledList.json(), { capabilities: ['resumable-upload'] });
    const created = await ctx.client.createUploadSession(enabled, body);
    assert.equal(created.status, 201, created.text());
    assert.equal(created.json<{ state: string }>().state, 'OPEN');

    // 허용하지 않은 namespace는 목록이 비어 있고 세션 생성이 409이며 경로가 생기지 않는다.
    const disabledList = await ctx.client.listCapabilities(disabled);
    assert.equal(disabledList.status, 200);
    assert.deepEqual(disabledList.json(), { capabilities: [] });
    const rejected = await ctx.client.createUploadSession(disabled, body);
    assert.equal(rejected.status, 409, rejected.text());
    assert.equal(rejected.json<{ code: string }>().code, 'VFS_FEATURE_DISABLED');
    assert.equal((await ctx.client.getStat(disabled, '/gated.bin')).status, 404);

    // 비활성 capability가 일반 파일 API를 막지 않는다.
    const bytes = Buffer.from('capability 없이도 저장된다', 'utf-8');
    const stored = await ctx.client.putConditionalContent(disabled, '/plain.txt', bytes, { ifAbsent: true });
    assert.equal(stored.status, 201);
    assert.deepEqual((await ctx.client.getContent(disabled, '/plain.txt')).bytes, bytes);
  },
});
