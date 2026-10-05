// 소비자 기대: 업로드 세션 생성은 같은 경로·조건의 조건부 업로드와 같은 상태·오류 코드로 거부된다. 생성에서 통과한 요청이 완료 시점에 다른 이유로 거부되지 않는다.
// 대응 요구사항: RQ-018(안정적인 오류 분류), RQ-027(선택 capability).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

type Condition = { ifAbsent: true } | { ifRevision: string };

export default defineContract({
  id: 'upload-session-create-precondition-order',
  title: '업로드 세션 생성은 조건부 업로드와 같은 순서로 대상 조건·조상 경로·디렉터리 대상을 판정한다',
  rq: ['RQ-018', 'RQ-027'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    const file = await ctx.client.putConditionalContent(ns, '/file', Buffer.from('f'), { ifAbsent: true });
    assert.equal(file.status, 201, file.text());
    const dirStat = await ctx.client.getStat(ns, '/dir');
    assert.equal(dirStat.status, 200, dirStat.text());
    const dirRevision = dirStat.json<{ revision: string }>().revision;
    // 다른 노드의 revision 형식 값. 대상 /dir와는 일치하지 않는다.
    const staleRevision = file.json<{ resource: { revision: string } }>().resource.revision;

    const cases: Array<{ name: string; path: string; condition: Condition; status: number; code: string }> = [
      {
        name: '중간 경로가 파일',
        path: '/file/x.bin',
        condition: { ifAbsent: true },
        status: 409,
        code: 'VFS_NOT_DIRECTORY',
      },
      {
        name: '중간 경로 없음',
        path: '/missing/x.bin',
        condition: { ifAbsent: true },
        status: 404,
        code: 'VFS_NODE_NOT_FOUND',
      },
      {
        name: '디렉터리 대상·revision 불일치',
        path: '/dir',
        condition: { ifRevision: staleRevision },
        status: 412,
        code: 'VFS_PRECONDITION_FAILED',
      },
      {
        name: '디렉터리 대상·revision 일치',
        path: '/dir',
        condition: { ifRevision: dirRevision },
        status: 409,
        code: 'VFS_IS_DIRECTORY',
      },
    ];
    for (const { name, path, condition, status, code } of cases) {
      const conditional = await ctx.client.putConditionalContent(ns, path, Buffer.alloc(0), condition);
      assert.equal(conditional.status, status, `조건부 업로드 ${name}: ${conditional.text()}`);
      assert.equal(conditional.json<{ code: string }>().code, code, `조건부 업로드 ${name}`);

      const created = await ctx.client.createUploadSession(
        ns,
        { path, sizeBytes: '0', mimeType: 'application/octet-stream', ...condition },
        { idempotencyKey: randomUUID() },
      );
      assert.equal(created.status, status, `세션 생성 ${name}: ${created.text()}`);
      assert.equal(created.json<{ code: string }>().code, code, `세션 생성 ${name}`);
    }
  },
});
