// 소비자 기대: archive는 선택한 FILE의 검증된 스냅샷을 ZIP FILE로 만들고, 같은 요청을 재생하며, stale revision을 저장 없이 거부한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import { assertReplayed } from '../../support/assert-replayed.ts';

interface Stat {
  id: string;
  revision: string;
}

interface Created {
  resource: {
    id: string;
    path: string;
    revision: string;
    mimeType: string;
    size: number;
    expiresAt?: string | null;
  };
  entryCount: number;
}

export default defineContract({
  id: 'archive-create',
  title:
    'archive는 선택 FILE의 ZIP FILE을 생성하고 stale revision을 거부하며 같은 요청은 최초 결과를 재생한다',
  rq: ['RQ-035', 'RQ-018', 'RQ-027'],
  profile: 'archive',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const source = Buffer.from([0, 1, 2, 127, 128, 255]);
    const saved = await ctx.client.putConditionalContent(ns, '/source.bin', source, { ifAbsent: true });
    assert.equal(saved.status, 201, saved.text());
    const stat = (await ctx.client.getStat(ns, '/source.bin')).json<Stat>();
    const body = {
      target: '/bundle.zip',
      entries: [{ id: stat.id, name: 'source.bin', revision: stat.revision }],
    };
    const key = randomUUID();
    const created = await ctx.client.createArchive(ns, body, { idempotencyKey: key, expiresInSeconds: 60 });
    assert.equal(created.status, 201, created.text());
    const result = created.json<Created>();
    assert.equal(result.entryCount, 1);
    assert.equal(result.resource.path, '/bundle.zip');
    assert.equal(result.resource.mimeType, 'application/zip');
    assert.ok(result.resource.size > 0);
    assert.equal(typeof result.resource.expiresAt, 'string');
    assertReplayed(
      await ctx.client.createArchive(ns, body, { idempotencyKey: key, expiresInSeconds: 60 }),
      created,
      'archive 재생',
    );
    const updated = await ctx.client.putConditionalContent(ns, '/source.bin', Buffer.from('changed'), {
      ifRevision: stat.revision,
    });
    assert.equal(updated.status, 200, updated.text());
    const stale = await ctx.client.createArchive(ns, {
      target: '/stale.zip',
      entries: [{ ...body.entries[0], revision: stat.revision }],
    });
    assert.equal(stale.status, 412, stale.text());
    assert.equal((await ctx.client.getStat(ns, '/stale.zip')).status, 404);

    const tooMany = await ctx.client.createArchive(ns, {
      target: '/too-many.zip',
      entries: Array.from({ length: 1001 }, (_, index) => ({
        id: stat.id,
        name: `entry-${index}.bin`,
      })),
    });
    assert.equal(tooMany.status, 413, tooMany.text());
    assert.equal((await ctx.client.getStat(ns, '/too-many.zip')).status, 404);

    const encryptedNs = ns;
    const encryptedSource = await ctx.client.putConditionalContent(
      encryptedNs,
      '/secret.bin',
      Buffer.from('encrypted archive source'),
      { ifAbsent: true },
    );
    assert.equal(encryptedSource.status, 201, encryptedSource.text());
    const encryptedStat = (await ctx.client.getStat(encryptedNs, '/secret.bin')).json<Stat>();
    const encryptedArchive = await ctx.client.createArchive(encryptedNs, {
      target: '/secret.zip',
      entries: [{ id: encryptedStat.id, name: 'secret.bin', revision: encryptedStat.revision }],
    });
    assert.equal(encryptedArchive.status, 201, encryptedArchive.text());
    const downloaded = await ctx.client.getContent(encryptedNs, '/secret.zip');
    assert.equal(downloaded.status, 200, downloaded.text());
    assert.equal(downloaded.bytes.subarray(0, 4).toString('hex'), '504b0304');
  },
});
