// 소비자 기대: 디렉터리를 자기 subtree로 이동·복사하면 목적지 중간 경로가 없거나 파일이어도 409 VFS_INVALID_OPERATION으로 거부되고 트리는 그대로다.
// 대응 요구사항: RQ-025(파일·디렉터리 이동), RQ-026(파일·디렉터리 복사). 규칙 출처는 docs/design/05-vfs-path-contract.md.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

export default defineContract({
  id: 'move-copy-subtree-precedence',
  title: '자기 subtree 이동·복사는 목적지 중간 경로가 없거나 파일이어도 409 VFS_INVALID_OPERATION이 우선한다',
  rq: ['RQ-025', 'RQ-026'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    assert.equal((await ctx.client.mkdir(ns, '/a')).status, 201);
    const created = await ctx.client.putConditionalContent(ns, '/a/f', Buffer.from('f'), { ifAbsent: true });
    assert.equal(created.status, 201, created.text());
    const listNames = async (path: string): Promise<string[]> =>
      (await ctx.client.listDirectory(ns, path))
        .json<{ items: Array<{ name: string }> }>()
        .items.map((item) => item.name)
        .sort();
    const before = await listNames('/a');

    const cases = [
      { destination: '/a/x/y', reason: '중간 경로 없음' },
      { destination: '/a/f/y', reason: '중간 경로가 파일' },
      { destination: '/a/x/y', destinationParents: true, reason: '부모 생성 요청' },
    ];
    for (const operation of ['move', 'copy'] as const) {
      for (const { reason, ...target } of cases) {
        const response = await ctx.client[operation](ns, { source: '/a', ...target });
        assert.equal(response.status, 409, `${operation} ${reason}: ${response.text()}`);
        assert.equal(
          response.json<{ code: string }>().code,
          'VFS_INVALID_OPERATION',
          `${operation} ${reason}`,
        );
      }
    }

    // 거부된 요청은 중간 디렉터리를 만들지 않는다.
    assert.deepEqual(await listNames('/a'), before);
  },
});
