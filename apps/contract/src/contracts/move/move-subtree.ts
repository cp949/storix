// 소비자 기대: 조건부 이동은 노드와 하위 전체를 새 경로로 옮기고 안정 ID·바이트를 유지하며, 응답의 affected revision은 이동 뒤 상태를 가리킨다.
// 대응 요구사항: RQ-025(파일·디렉터리 이동).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Stat {
  id: string;
  revision: string;
}

export default defineContract({
  id: 'move-subtree',
  title: '조건부 이동은 하위 전체를 옮기며 ID와 바이트를 유지하고 affected revision이 새 상태를 가리킨다',
  rq: ['RQ-025'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const statOf = async (path: string): Promise<Stat> => {
      const response = await ctx.client.getStat(ns, path);
      assert.equal(response.status, 200, path);
      return response.json<Stat>();
    };

    assert.equal((await ctx.client.mkdir(ns, '/src')).status, 201);
    assert.equal((await ctx.client.mkdir(ns, '/src/sub')).status, 201);
    const contents: Record<string, Buffer> = {
      '/src/a.txt': Buffer.from('첫 번째 파일', 'utf-8'),
      '/src/sub/b.txt': Buffer.from('하위 파일', 'utf-8'),
    };
    for (const [path, bytes] of Object.entries(contents)) {
      const response = await ctx.client.putConditionalContent(ns, path, bytes, { ifAbsent: true });
      assert.equal(response.status, 201, path);
    }
    const relatives = ['', '/a.txt', '/sub', '/sub/b.txt'];
    const before = new Map<string, string>();
    for (const relative of relatives) before.set(relative, (await statOf(`/src${relative}`)).id);

    // 지정 경로 자체가 목적지가 되도록 exact로 옮긴다.
    const moved = await ctx.client.postMutation(ns, {
      kind: 'move',
      source: '/src',
      destination: '/dst',
      sourceRevision: (await statOf('/src')).revision,
      destinationAbsent: true,
      destinationResolution: 'exact',
    });
    assert.equal(moved.status, 200, moved.text());

    // 원래 경로는 사라지고 하위 전체가 새 경로에서 같은 ID로 조회된다.
    for (const relative of relatives) {
      assert.equal((await ctx.client.getStat(ns, `/src${relative}`)).status, 404, `/src${relative}`);
      assert.equal((await statOf(`/dst${relative}`)).id, before.get(relative), `/dst${relative}`);
    }
    for (const [path, bytes] of Object.entries(contents)) {
      const content = await ctx.client.getContent(ns, path.replace('/src', '/dst'));
      assert.deepEqual(content.bytes, bytes, path);
    }

    // affected revision은 이동 뒤에 실제로 존재하는 경로의 현재 revision과 같다.
    const affected = moved.json<{ affectedRevisions: Array<{ path: string; revision: string }> }>()
      .affectedRevisions;
    assert.ok(affected.length > 0, 'affectedRevisions가 비어 있으면 안 된다');
    for (const item of affected) {
      assert.equal((await statOf(item.path)).revision, item.revision, item.path);
    }

    // exact를 생략하면 기존 디렉터리 아래에 원본 이름으로 배치한다.
    assert.equal((await ctx.client.mkdir(ns, '/box')).status, 201);
    const file = await statOf('/dst/a.txt');
    const placed = await ctx.client.postMutation(ns, {
      kind: 'move',
      source: '/dst/a.txt',
      destination: '/box',
      sourceRevision: file.revision,
      destinationAbsent: true,
    });
    assert.equal(placed.status, 200, placed.text());
    assert.equal((await statOf('/box/a.txt')).id, file.id);
    assert.equal((await ctx.client.getStat(ns, '/dst/a.txt')).status, 404);
  },
});
