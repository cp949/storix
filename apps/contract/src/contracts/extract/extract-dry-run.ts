// 소비자 기대: extract dryRun은 대상을 바꾸지 않고 제외를 반영한 선택 entry 목록을 돌려주며, 같은 key로 본 실행을 이어 보낼 수 있다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import { readFileText, stageArchive } from '../../support/stage-archive.ts';
import { tarBytes } from '../../support/tar-bytes.ts';

interface DryRun {
  format: string;
  entryCount: number;
  totalBytes: number;
  entries: { name: string; type: string; size: number }[];
}

export default defineContract({
  id: 'extract-dry-run',
  title:
    'extract dryRun은 대상을 바꾸지 않고 제외를 반영한 entry 목록을 돌려주며 같은 key로 본 실행을 이어 보낼 수 있다',
  rq: ['RQ-036'],
  profile: 'extract',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    // plain tar도 공개 계약에 포함한다. 선행 `./`는 응답 이름에서 벗겨진다.
    const staged = await stageArchive(
      ctx,
      ns,
      tarBytes([
        { name: './', type: 'dir' },
        { name: './index.html', body: 'home' },
        { name: './__MACOSX/._index.html', body: 'junk' },
        { name: './empty/', type: 'dir' },
        { name: './docs/readme.txt', body: 'readme' },
      ]),
    );
    const key = randomUUID();
    const request = { ...staged, destination: '/site', mode: 'overwrite', exclude: ['__MACOSX/**'] };
    const dry = await ctx.client.extract(ns, { ...request, dryRun: true }, { idempotencyKey: key });
    assert.equal(dry.status, 200, dry.text());
    assert.deepEqual(dry.json<DryRun>(), {
      format: 'tar',
      entryCount: 3,
      totalBytes: 10,
      entries: [
        { name: 'index.html', type: 'FILE', size: 4 },
        { name: 'empty', type: 'DIRECTORY', size: 0 },
        { name: 'docs/readme.txt', type: 'FILE', size: 6 },
      ],
    });
    assert.equal((await ctx.client.getStat(ns, '/site')).status, 404, 'dryRun은 대상을 만들지 않는다');

    // 성공한 dryRun은 receipt를 남기지 않으므로 같은 key로 본 실행을 보낼 수 있다.
    const real = await ctx.client.extract(ns, request, { idempotencyKey: key });
    assert.equal(real.status, 201, real.text());
    assert.equal(await readFileText(ctx, ns, '/site/docs/readme.txt'), 'readme');
    assert.equal(
      (await ctx.client.getStat(ns, '/site/__MACOSX')).status,
      404,
      '제외한 entry는 만들지 않는다',
    );
  },
});
