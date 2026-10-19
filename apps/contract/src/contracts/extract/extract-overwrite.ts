// 소비자 기대: extract overwrite는 같은 경로 FILE의 id를 유지해 내용을 교체하고 나머지 FILE을 남기며, 같은 요청은 최초 결과를 재생한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import { assertReplayed } from '../../support/assert-replayed.ts';
import { putFile, readFileText, stageArchive } from '../../support/stage-archive.ts';
import { tarGzBytes } from '../../support/tar-bytes.ts';

interface Stat {
  id: string;
  version: number;
  revision: string;
  type: string;
  mimeType: string | null;
}

interface Applied {
  resource: { path: string; type: string; version: number };
  affectedRevisions: { path: string; revision: string }[];
  entryCount: number;
  createdCount: number;
  replacedCount: number;
  trashId?: string;
}

export default defineContract({
  id: 'extract-overwrite',
  title:
    'extract overwrite는 같은 경로 FILE의 id를 유지해 내용을 교체하고 나머지 FILE을 남기며 같은 요청은 최초 결과를 재생한다',
  rq: ['RQ-036', 'RQ-018'],
  profile: 'extract',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    await putFile(ctx, ns, '/site/index.html', 'old');
    await putFile(ctx, ns, '/site/keep.txt', 'keep');
    const before = (await ctx.client.getStat(ns, '/site/index.html')).json<Stat>();
    const staged = await stageArchive(
      ctx,
      ns,
      tarGzBytes([
        { name: 'index.html', body: 'new' },
        { name: 'assets/app.css', body: 'body{}' },
      ]),
    );

    const key = randomUUID();
    const body = { ...staged, destination: '/site', mode: 'overwrite', mimeTypes: { '.css': 'text/css' } };
    const first = await ctx.client.extract(ns, body, { idempotencyKey: key });
    // 대상이 이미 있었으므로 200이다. entryCount·createdCount·replacedCount는 [2, 1, 1]이다.
    assert.equal(first.status, 200, first.text());
    const applied = first.json<Applied>();
    assert.deepEqual([applied.entryCount, applied.createdCount, applied.replacedCount], [2, 1, 1]);
    assert.equal(applied.resource.path, '/site');
    assert.equal(applied.resource.type, 'DIRECTORY');
    assert.equal(applied.trashId, undefined);

    const after = (await ctx.client.getStat(ns, '/site/index.html')).json<Stat>();
    assert.equal(after.id, before.id, '교체한 FILE의 id가 유지돼야 한다');
    assert.equal(after.version, before.version + 1);
    assert.equal(await readFileText(ctx, ns, '/site/index.html'), 'new');
    assert.equal(await readFileText(ctx, ns, '/site/keep.txt'), 'keep');
    assert.equal(await readFileText(ctx, ns, '/site/assets/app.css'), 'body{}');
    assert.equal((await ctx.client.getStat(ns, '/site/assets/app.css')).json<Stat>().mimeType, 'text/css');
    assert.equal(after.mimeType, 'application/octet-stream');

    // 일반 resource에는 revision이 없으므로 stat과 affectedRevisions로 최종 상태를 대조한다.
    const site = (await ctx.client.getStat(ns, '/site')).json<Stat>();
    assert.equal(applied.resource.version, site.version);
    assert.equal(applied.affectedRevisions.find((item) => item.path === '/site')?.revision, site.revision);

    assertReplayed(await ctx.client.extract(ns, body, { idempotencyKey: key }), first, 'extract 재생');
    assert.equal((await ctx.client.getStat(ns, '/site')).json<Stat>().version, site.version);

    // 같은 key에 다른 요청을 보내면 거부한다.
    const reused = await ctx.client.extract(ns, { ...body, mode: 'clean' }, { idempotencyKey: key });
    assert.equal(reused.status, 409, reused.text());
    assert.equal(reused.json<{ code: string }>().code, 'MUTATION_KEY_REUSED');
  },
});
