// 소비자 기대: 조건부 복사는 연산 시점의 구조와 바이트를 새 ID의 자원으로 만들고, 이후 원본과 복사본은 서로 영향을 주지 않으며, 원본 snapshot 이력은 복제되지 않는다.
// 대응 요구사항: RQ-026(파일·디렉터리 복사).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface Stat {
  id: string;
  revision: string;
}

export default defineContract({
  id: 'copy-subtree',
  title:
    '조건부 복사는 새 ID로 구조와 바이트를 복제하고, 원본과 복사본은 독립이며 snapshot 이력은 복제되지 않는다',
  rq: ['RQ-026'],
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
    // 원본 파일의 snapshot은 복사본으로 이어지지 않는다.
    const snapshot = await ctx.client.createSnapshot(ns, { kind: 'file', path: '/src/a.txt' });
    assert.equal(snapshot.status, 201);

    const relatives = ['', '/a.txt', '/sub', '/sub/b.txt'];
    const original = new Map<string, Stat>();
    for (const relative of relatives) original.set(relative, await statOf(`/src${relative}`));

    const copied = await ctx.client.postMutation(ns, {
      kind: 'copy',
      source: '/src',
      destination: '/dup',
      sourceRevision: original.get('')!.revision,
      destinationAbsent: true,
      destinationResolution: 'exact',
    });
    assert.equal(copied.status, 201, copied.text());

    // 구조와 바이트는 같고 노드 ID는 모두 새 값이며, 원본은 그대로다.
    const seenIds = new Set<string>();
    for (const relative of relatives) {
      const source = original.get(relative)!;
      const copy = await statOf(`/dup${relative}`);
      assert.notEqual(copy.id, source.id, `/dup${relative}`);
      assert.ok(!seenIds.has(copy.id), '복사본 ID끼리도 겹치면 안 된다');
      seenIds.add(copy.id);
      assert.deepEqual(await statOf(`/src${relative}`), source, `/src${relative} 원본 무변경`);
    }
    for (const [path, bytes] of Object.entries(contents)) {
      assert.deepEqual((await ctx.client.getContent(ns, path.replace('/src', '/dup'))).bytes, bytes, path);
    }

    // 복사본에는 원본 파일의 snapshot 이력이 없다.
    const copyFileId = (await statOf('/dup/a.txt')).id;
    const copySnapshots = await ctx.client.listSnapshots(ns, copyFileId);
    assert.equal(copySnapshots.status, 200);
    assert.deepEqual(copySnapshots.json<{ items: unknown[] }>().items, []);

    // 원본을 바꿔도 복사본은 그대로이고, 복사본을 지워도 원본은 그대로다.
    const changed = Buffer.from('원본만 바꾼 내용', 'utf-8');
    const replaced = await ctx.client.putConditionalContent(ns, '/src/a.txt', changed, {
      ifRevision: original.get('/a.txt')!.revision,
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual((await ctx.client.getContent(ns, '/dup/a.txt')).bytes, contents['/src/a.txt']);
    const removed = await ctx.client.remove(ns, '/dup/sub/b.txt');
    assert.equal(removed.status, 204);
    assert.deepEqual((await ctx.client.getContent(ns, '/src/sub/b.txt')).bytes, contents['/src/sub/b.txt']);
    assert.deepEqual((await ctx.client.getContent(ns, '/src/a.txt')).bytes, changed);
  },
});
