// 소비자 기대: extract clean은 기존 대상 subtree와 그 안의 압축 FILE을 지우고 새 트리를 만들며, 휴지통이 켜져 있으면 지운 내용을 되살릴 수 있다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';
import { putFile, readFileText, stageArchive } from '../../support/stage-archive.ts';
import { zipBytes } from '../../support/zip-bytes.ts';

interface Applied {
  entryCount: number;
  createdCount: number;
  replacedCount: number;
  trashId?: string;
}

const archive = () =>
  zipBytes([
    { name: 'index.html', body: 'fresh', deflate: true },
    { name: 'empty/' },
    { name: 'deep/er/file.txt', body: 'deep' },
  ]);

export default defineContract({
  id: 'extract-clean',
  title:
    'extract clean은 기존 대상과 그 안의 압축 FILE을 지우고 새 트리를 만들며 휴지통이 켜져 있으면 지운 내용을 복구할 수 있다',
  rq: ['RQ-036'],
  profile: 'extract',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    await putFile(ctx, ns, '/site/old.txt', 'old');
    await putFile(ctx, ns, '/site/sub/old2.txt', 'old2');
    // 압축 FILE이 대상 안에 있으면 clean이 함께 지운다.
    const inside = await stageArchive(ctx, ns, archive(), '/site/upload.zip');
    const cleaned = await ctx.client.extract(ns, { ...inside, destination: '/site', mode: 'clean' });
    assert.equal(cleaned.status, 200, cleaned.text());
    const applied = cleaned.json<Applied>();
    assert.deepEqual([applied.entryCount, applied.createdCount, applied.replacedCount], [3, 2, 0]);
    assert.equal(applied.trashId, undefined, '휴지통이 꺼져 있으면 trashId가 없다');
    for (const gone of ['/site/old.txt', '/site/sub', '/site/upload.zip'])
      assert.equal((await ctx.client.getStat(ns, gone)).status, 404, gone);
    assert.equal(await readFileText(ctx, ns, '/site/index.html'), 'fresh');
    assert.equal(await readFileText(ctx, ns, '/site/deep/er/file.txt'), 'deep');
    assert.equal((await ctx.client.getStat(ns, '/site/empty')).json<{ type: string }>().type, 'DIRECTORY');

    // 없던 대상은 clean이어도 201이다.
    const outside = await stageArchive(ctx, ns, archive(), '/.staging/fresh.zip');
    const created = await ctx.client.extract(ns, { ...outside, destination: '/fresh', mode: 'clean' });
    assert.equal(created.status, 201, created.text());
    assert.equal(await readFileText(ctx, ns, '/fresh/index.html'), 'fresh');

    // 휴지통이 켜진 namespace는 지운 내용을 trashId로 복구한다.
    const trashNs = (await ctx.createNamespace()).id;
    const enabled = await ctx.client.updateNamespaceTrashPolicy(trashNs, ctx.adminKey, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text());
    await putFile(ctx, trashNs, '/site/old.txt', 'old');
    const staged = await stageArchive(ctx, trashNs, archive());
    const withTrash = await ctx.client.extract(trashNs, { ...staged, destination: '/site', mode: 'clean' });
    assert.equal(withTrash.status, 200, withTrash.text());
    const trashId = withTrash.json<Applied>().trashId;
    assert.equal(typeof trashId, 'string');
    assert.equal((await ctx.client.getStat(trashNs, '/site/old.txt')).status, 404);
    const restored = await ctx.client.restoreTrash(trashNs, trashId!, { targetPath: '/recovered' });
    assert.ok(restored.status < 300, restored.text());
    assert.equal(await readFileText(ctx, trashNs, '/recovered/old.txt'), 'old');
  },
});
