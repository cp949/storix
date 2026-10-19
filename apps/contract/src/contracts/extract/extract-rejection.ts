// 소비자 기대: extract는 위험한 이름·link·손상·미지원 형식과 맞지 않는 전제 조건을 대상을 바꾸지 않고 공개 code로 거부하며, 오류 재생이 최초 응답과 같다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import { assertReplayed } from '../../support/assert-replayed.ts';
import { putFile, stageArchive } from '../../support/stage-archive.ts';
import { tarBytes } from '../../support/tar-bytes.ts';
import { zipBytes } from '../../support/zip-bytes.ts';

interface Failure {
  code: string;
  entryIndex?: number;
  entryName?: string;
  path?: string;
  current?: { path: string; type: string; revision: string } | null;
}

export default defineContract({
  id: 'extract-rejection',
  title:
    'extract는 위험한 이름·link·손상·미지원 형식과 전제 조건 위반을 대상을 바꾸지 않고 거부하며 오류 재생이 최초 응답과 같다',
  rq: ['RQ-036', 'RQ-018'],
  profile: 'extract',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    let sequence = 0;
    const stage = (archive: Buffer) =>
      stageArchive(ctx, ns, archive, `/.staging/rejection-${(sequence += 1)}.bin`);
    const failure = (response: { status: number; text(): string; json<T>(): T }, status: number): Failure => {
      assert.equal(response.status, status, response.text());
      return response.json<Failure>();
    };
    const untouched = async (path: string) =>
      assert.equal((await ctx.client.getStat(ns, path)).status, 404, `${path}는 만들어지면 안 된다`);

    // 경로 이탈은 첫 entry의 순번과 원래 이름을 돌려준다.
    const traversal = failure(
      await ctx.client.extract(ns, {
        ...(await stage(tarBytes([{ name: '../evil', body: 'x' }]))),
        destination: '/traversal',
        mode: 'overwrite',
      }),
      400,
    );
    assert.deepEqual(
      [traversal.code, traversal.entryIndex, traversal.entryName],
      ['VFS_EXTRACT_INVALID_ENTRY', 0, '../evil'],
    );
    await untouched('/traversal');

    // 앞의 정상 entry는 순번에 세고 link entry는 두 번째 순번으로 거부한다.
    const symlink = failure(
      await ctx.client.extract(ns, {
        ...(await stage(
          tarBytes([
            { name: 'ok.txt', body: 'ok' },
            { name: 'link', type: 'symlink', linkName: '/etc/passwd' },
          ]),
        )),
        destination: '/symlink',
        mode: 'overwrite',
      }),
      400,
    );
    assert.deepEqual(
      [symlink.code, symlink.entryIndex, symlink.entryName],
      ['VFS_EXTRACT_INVALID_ENTRY', 1, 'link'],
    );
    await untouched('/symlink');

    // ZIP은 local header와 central directory의 이름이 다르면 거부한다.
    const mismatch = failure(
      await ctx.client.extract(ns, {
        ...(await stage(zipBytes([{ name: 'aa.txt', body: 'x', localName: 'bb.txt' }]))),
        destination: '/mismatch',
        mode: 'overwrite',
      }),
      400,
    );
    assert.deepEqual(
      [mismatch.code, mismatch.entryIndex, mismatch.entryName],
      ['VFS_EXTRACT_INVALID_ENTRY', 0, 'aa.txt'],
    );
    await untouched('/mismatch');

    // 뒤쪽 entry의 CRC 손상도 대상을 만들지 않는다.
    const crc = failure(
      await ctx.client.extract(ns, {
        ...(await stage(
          zipBytes([
            { name: 'ok.txt', body: 'ok' },
            { name: 'bad.txt', body: 'bad', crc: 1 },
          ]),
        )),
        destination: '/crc',
        mode: 'overwrite',
      }),
      400,
    );
    assert.deepEqual([crc.code, crc.entryIndex, crc.entryName], ['VFS_EXTRACT_INVALID_ENTRY', 1, 'bad.txt']);
    await untouched('/crc');

    // 지원하지 않는 형식(bzip2)은 형식 오류다.
    const unsupported = failure(
      await ctx.client.extract(ns, {
        ...(await stage(Buffer.concat([Buffer.from('BZh91AY&SY'), Buffer.alloc(600, 0x78)]))),
        destination: '/bzip2',
        mode: 'overwrite',
      }),
      400,
    );
    assert.equal(unsupported.code, 'VFS_EXTRACT_UNSUPPORTED_FORMAT');
    await untouched('/bzip2');

    // 알 수 없는 키는 요청 오류다.
    const unknownKey = failure(
      await ctx.client.extract(ns, {
        ...(await stage(tarBytes([{ name: 'a', body: 'a' }]))),
        destination: '/unknown',
        mode: 'overwrite',
        stripComponents: 1,
      }),
      400,
    );
    assert.equal(unknownKey.code, 'VFS_INVALID_EXTRACT_REQUEST');

    // source revision이 바뀌었으면 412이고 현재 상태를 돌려준다.
    const stale = await stage(tarBytes([{ name: 'a', body: 'a' }]));
    const replaced = await ctx.client.putConditionalContent(ns, stale.source, Buffer.from('changed'), {
      ifRevision: stale.sourceRevision,
    });
    assert.equal(replaced.status, 200, replaced.text());
    const conflict = failure(
      await ctx.client.extract(ns, { ...stale, destination: '/stale', mode: 'overwrite' }),
      412,
    );
    assert.equal(conflict.code, 'VFS_PRECONDITION_FAILED');
    assert.equal(conflict.path, stale.source);
    assert.equal(conflict.current?.path, stale.source);
    await untouched('/stale');

    // 대상이 FILE이면 409다.
    await putFile(ctx, ns, '/plain.txt', 'file');
    const notDirectory = failure(
      await ctx.client.extract(ns, {
        ...(await stage(tarBytes([{ name: 'a', body: 'a' }]))),
        destination: '/plain.txt',
        mode: 'overwrite',
      }),
      409,
    );
    assert.equal(notDirectory.code, 'VFS_NOT_DIRECTORY');

    // 기존 FILE과 종류가 다른 entry는 409이며 앞 entry도 반영하지 않고, 오류 재생에도 entry 정보가 같다.
    await putFile(ctx, ns, '/site/assets', 'not a directory');
    const clash = await stage(
      tarBytes([
        { name: 'first.txt', body: 'first' },
        { name: 'assets/app.js', body: 'js' },
      ]),
    );
    const key = randomUUID();
    const clashBody = { ...clash, destination: '/site', mode: 'overwrite' };
    const clashed = await ctx.client.extract(ns, clashBody, { idempotencyKey: key });
    const clashFailure = failure(clashed, 409);
    assert.deepEqual(
      [clashFailure.code, clashFailure.entryIndex, clashFailure.entryName, clashFailure.path],
      ['VFS_EXTRACT_TYPE_CONFLICT', 1, 'assets/app.js', '/site/assets'],
    );
    await untouched('/site/first.txt');
    assertReplayed(
      await ctx.client.extract(ns, clashBody, { idempotencyKey: key }),
      clashed,
      '종류 충돌 재생',
    );

    // 허용하지 않은 namespace는 capability가 꺼져 있어 409이고 receipt를 남기지 않는다.
    const disabledNs = (await ctx.createNamespace({ withoutCapabilities: true })).id;
    const disabledSource = await stageArchive(ctx, disabledNs, tarBytes([{ name: 'a', body: 'a' }]));
    const disabled = await ctx.client.extract(disabledNs, {
      ...disabledSource,
      destination: '/site',
      mode: 'overwrite',
    });
    assert.equal(disabled.status, 409, disabled.text());
    assert.equal(disabled.json<Failure>().code, 'VFS_FEATURE_DISABLED');
    assert.equal((await ctx.client.getStat(disabledNs, '/site')).status, 404);
  },
});
