// 소비자 기대: 본문 없이 조회한 메타데이터의 크기·해시·revision이 같은 상태의 전체 조회 결과와 일치한다.
// 대응 요구사항: RQ-007(본문 없는 메타데이터 조회).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface Stat {
  id: string;
  path: string;
  type: string;
  size: number | null;
  mimeType: string | null;
  updatedAt: string;
  revision: string;
  sha256: string | null;
}

interface ConditionalResult {
  resource: { id: string; revision: string };
}

export default defineContract({
  id: 'stat-metadata',
  title: 'stat의 ID·경로·크기·MIME·해시·revision이 같은 상태의 전체 조회와 일치한다',
  rq: ['RQ-007'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;
    const first = Buffer.from('메타데이터 확인용 본문', 'utf-8');
    const second = Buffer.from('교체된 본문', 'utf-8');

    const created = await ctx.client.putConditionalContent(
      ns,
      '/meta.txt',
      first,
      { ifAbsent: true },
      {
        contentType: 'text/plain',
      },
    );
    assert.equal(created.status, 201);
    const v1 = created.json<ConditionalResult>().resource;

    // stat의 값이 저장한 바이트와 전체 조회 헤더에 일치한다.
    const stat1 = (await ctx.client.getStat(ns, '/meta.txt')).json<Stat>();
    const read1 = await ctx.client.getContent(ns, '/meta.txt');
    assert.equal(stat1.id, v1.id);
    assert.equal(stat1.path, '/meta.txt');
    assert.equal(stat1.type, 'FILE');
    assert.equal(stat1.size, first.length);
    assert.equal(stat1.size, read1.bytes.length);
    assert.equal(stat1.mimeType, 'text/plain');
    assert.equal(stat1.revision, v1.revision);
    assert.equal(stat1.revision, read1.headers.get('x-storix-revision'));
    assert.equal(stat1.sha256, sha256(first));
    assert.equal(stat1.sha256, read1.headers.get('x-storix-sha256'));
    assert.ok(!Number.isNaN(Date.parse(stat1.updatedAt)), 'updatedAt이 날짜 형식이어야 한다');

    // 교체하면 같은 ID에 새 revision·크기·해시가 함께 바뀐다.
    const replaced = await ctx.client.putConditionalContent(ns, '/meta.txt', second, {
      ifRevision: v1.revision,
    });
    assert.equal(replaced.status, 200);
    const stat2 = (await ctx.client.getStat(ns, '/meta.txt')).json<Stat>();
    assert.equal(stat2.id, v1.id);
    assert.notEqual(stat2.revision, stat1.revision);
    assert.equal(stat2.size, second.length);
    assert.equal(stat2.sha256, sha256(second));
    assert.ok(Date.parse(stat2.updatedAt) >= Date.parse(stat1.updatedAt), 'updatedAt이 거꾸로 가면 안 된다');

    // 빈 파일의 해시는 빈 바이트열의 SHA-256이다.
    const empty = await ctx.client.putConditionalContent(ns, '/empty.txt', Buffer.alloc(0), {
      ifAbsent: true,
    });
    assert.equal(empty.status, 201);
    const emptyStat = (await ctx.client.getStat(ns, '/empty.txt')).json<Stat>();
    assert.equal(emptyStat.size, 0);
    assert.equal(emptyStat.sha256, EMPTY_SHA256);

    // 디렉터리는 파일 해시가 없다.
    assert.equal((await ctx.client.mkdir(ns, '/dir')).status, 201);
    const dirStat = (await ctx.client.getStat(ns, '/dir')).json<Stat>();
    assert.equal(dirStat.type, 'DIRECTORY');
    assert.equal(dirStat.sha256, null);

    // 없는 경로는 404다.
    assert.equal((await ctx.client.getStat(ns, '/missing.txt')).status, 404);
  },
});
