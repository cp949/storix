// 소비자 기대: archive 오류 응답은 어느 entry가 실패했는지(`archiveEntry`)와 재시도 규칙을 공개 code로 알려준다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface Stat {
  id: string;
  path: string;
  revision: string;
}

interface ErrorBody {
  code: string;
  archiveEntry?: number;
  path?: string;
  current?: { path: string; revision: string } | null;
}

export default defineContract({
  id: 'archive-errors',
  title:
    'archive 오류는 실패한 entry index·원본 경로와 공개 code를 돌려주고 입력이 다른 key 재사용을 거부한다',
  rq: ['RQ-035', 'RQ-018'],
  profile: 'archive',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const mkdir = await ctx.client.mkdir(ns, '/docs');
    assert.equal(mkdir.status, 201, mkdir.text());
    const saved = await ctx.client.putConditionalContent(ns, '/docs/source.bin', Buffer.from('v1'), {
      ifAbsent: true,
    });
    assert.equal(saved.status, 201, saved.text());
    const stat = (await ctx.client.getStat(ns, '/docs/source.bin')).json<Stat>();

    // 원본 revision 충돌: 두 번째 entry의 index와 원본 FILE의 VFS 절대 경로를 돌려준다.
    const updated = await ctx.client.putConditionalContent(ns, '/docs/source.bin', Buffer.from('v2'), {
      ifRevision: stat.revision,
    });
    assert.equal(updated.status, 200, updated.text());
    const latest = (await ctx.client.getStat(ns, '/docs/source.bin')).json<Stat>();
    const stale = await ctx.client.createArchive(ns, {
      target: '/stale.zip',
      entries: [
        { id: stat.id, name: 'fresh.bin' },
        { id: stat.id, name: 'stale.bin', revision: stat.revision },
      ],
    });
    assert.equal(stale.status, 412, stale.text());
    const staleBody = stale.json<ErrorBody>();
    assert.equal(staleBody.code, 'VFS_PRECONDITION_FAILED');
    assert.equal(staleBody.archiveEntry, 1);
    assert.equal(staleBody.path, '/docs/source.bin');
    assert.equal(staleBody.current?.path, '/docs/source.bin');
    assert.equal(staleBody.current?.revision, latest.revision);

    // 원본 부재: path 없이 index만 돌려준다.
    const missing = await ctx.client.createArchive(ns, {
      target: '/missing.zip',
      entries: [
        { id: stat.id, name: 'present.bin' },
        { id: randomUUID(), name: 'absent.bin' },
      ],
    });
    assert.equal(missing.status, 404, missing.text());
    const missingBody = missing.json<ErrorBody>();
    assert.equal(missingBody.code, 'VFS_NODE_NOT_FOUND');
    assert.equal(missingBody.archiveEntry, 1);
    assert.equal(missingBody.path, undefined);

    // revision 형식 오류는 400과 index다.
    const badRevision = await ctx.client.createArchive(ns, {
      target: '/bad-revision.zip',
      entries: [{ id: stat.id, name: 'source.bin', revision: 'not-a-revision' }],
    });
    assert.equal(badRevision.status, 400, badRevision.text());
    assert.deepEqual(
      { code: badRevision.json<ErrorBody>().code, archiveEntry: badRevision.json<ErrorBody>().archiveEntry },
      { code: 'VFS_INVALID_REVISION', archiveEntry: 0 },
    );

    // entry 상한 초과는 공개 code `VFS_ARCHIVE_TOO_LARGE`다.
    const tooMany = await ctx.client.createArchive(ns, {
      target: '/too-many.zip',
      entries: Array.from({ length: 1001 }, (_, index) => ({ id: stat.id, name: `entry-${index}.bin` })),
    });
    assert.equal(tooMany.status, 413, tooMany.text());
    assert.equal(tooMany.json<ErrorBody>().code, 'VFS_ARCHIVE_TOO_LARGE');

    // 같은 key로 입력을 바꾸면 최초 결과를 덮지 않고 409 MUTATION_KEY_REUSED다.
    const key = randomUUID();
    const created = await ctx.client.createArchive(
      ns,
      { target: '/reuse.zip', entries: [{ id: stat.id, name: 'source.bin' }] },
      { idempotencyKey: key },
    );
    assert.equal(created.status, 201, created.text());
    const reused = await ctx.client.createArchive(
      ns,
      { target: '/reuse.zip', entries: [{ id: stat.id, name: 'renamed.bin' }] },
      { idempotencyKey: key },
    );
    assert.equal(reused.status, 409, reused.text());
    assert.equal(reused.json<ErrorBody>().code, 'MUTATION_KEY_REUSED');
    assert.equal((await ctx.client.getStat(ns, '/reuse.zip')).status, 200);
    for (const path of ['/stale.zip', '/missing.zip', '/bad-revision.zip', '/too-many.zip']) {
      assert.equal((await ctx.client.getStat(ns, path)).status, 404, path);
    }
  },
});
