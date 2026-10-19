// 소비자 기대: extract는 선택 entry 수와 제외 FILE을 포함한 평문 합계를 기동 설정의 상한까지만 받고, 넘기면 대상을 바꾸지 않고 413으로 거부한다.
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';
import { putFile, readFileText, stageArchive } from '../../support/stage-archive.ts';
import { tarBytes } from '../../support/tar-bytes.ts';

interface Failure {
  code: string;
  message: string;
}

export default defineContract({
  id: 'extract-limits',
  title:
    'extract는 선택 entry 수와 제외 FILE을 포함한 평문 합계의 상한을 넘으면 대상을 바꾸지 않고 413으로 거부한다',
  rq: ['RQ-036'],
  profile: 'extract-limits',
  async run(ctx) {
    // 이 프로필의 상한은 선택 entry 2개, 평문 합계 32 byte다(`src/runner/profiles.ts`).
    const ns = (await ctx.createNamespace()).id;
    await putFile(ctx, ns, '/guard/keep.txt', 'keep');
    let sequence = 0;
    const extract = async (
      entries: Parameters<typeof tarBytes>[0],
      destination: string,
      exclude?: string[],
    ) => {
      sequence += 1;
      const staged = await stageArchive(ctx, ns, tarBytes(entries), `/.staging/limits-${sequence}.tar`);
      return ctx.client.extract(ns, {
        ...staged,
        destination,
        mode: 'overwrite',
        ...(exclude === undefined ? {} : { exclude }),
      });
    };
    const tooLarge = (response: Awaited<ReturnType<typeof extract>>, limit: string) => {
      assert.equal(response.status, 413, response.text());
      const failure = response.json<Failure>();
      assert.equal(failure.code, 'VFS_EXTRACT_TOO_LARGE');
      assert.ok(failure.message.includes(limit), failure.message);
    };

    // 선택 entry 2개는 통과하고 3개는 거부한다.
    const two = await extract(
      [
        { name: 'a', body: 'a' },
        { name: 'b', body: 'b' },
      ],
      '/two',
    );
    assert.equal(two.status, 201, two.text());
    tooLarge(
      await extract(
        [
          { name: 'a', body: 'a' },
          { name: 'b', body: 'b' },
          { name: 'c', body: 'c' },
        ],
        '/three',
      ),
      'entries',
    );
    assert.equal((await ctx.client.getStat(ns, '/three')).status, 404);

    // 제외한 entry는 선택 수에 세지 않는다. 원본 entry가 3개여도 2개가 선택되면 통과한다.
    const excluded = await extract(
      [
        { name: 'a', body: 'a' },
        { name: 'skip.txt', body: 's' },
        { name: 'b', body: 'b' },
      ],
      '/excluded',
      ['skip.txt'],
    );
    assert.equal(excluded.status, 201, excluded.text());
    assert.equal((await ctx.client.getStat(ns, '/excluded/skip.txt')).status, 404);

    // 평문 합계 32 byte는 통과하고 33 byte는 거부한다.
    const exact = await extract([{ name: 'exact.bin', body: 'x'.repeat(32) }], '/exact');
    assert.equal(exact.status, 201, exact.text());
    assert.equal((await readFileText(ctx, ns, '/exact/exact.bin')).length, 32);
    tooLarge(await extract([{ name: 'over.bin', body: 'x'.repeat(33) }], '/over'), 'bytes');
    assert.equal((await ctx.client.getStat(ns, '/over')).status, 404);

    // 제외한 FILE의 크기도 합계에 들어간다. 선택한 FILE은 10 byte뿐이어도 합계 40 byte라 거부한다.
    tooLarge(
      await extract(
        [
          { name: 'big.bin', body: 'x'.repeat(30) },
          { name: 'small.txt', body: 'y'.repeat(10) },
        ],
        '/skipped-big',
        ['big.bin'],
      ),
      'bytes',
    );
    assert.equal((await ctx.client.getStat(ns, '/skipped-big')).status, 404);

    // 한도 실패는 기존 대상을 바꾸지 않는다.
    tooLarge(await extract([{ name: 'keep.txt', body: 'z'.repeat(33) }], '/guard'), 'bytes');
    assert.equal(await readFileText(ctx, ns, '/guard/keep.txt'), 'keep');
  },
});
