// tar 순차 reader의 ustar·PAX·GNU longname 해석, 거부 entry, 잘린 입력, 끝 블록, source 소유권을 단위 테스트한다.
// 메모리 안의 Readable과 직접 만든 tar 바이트만 쓰며 DB와 저장소를 쓰지 않는다. 규칙은 docs/design/17-file-extract.md "실행"을 따른다.
import { Readable } from 'node:stream';
import { ExtractReaderError } from '../../src/vfs/extract-reader-error.js';
import { readTarEntries } from '../../src/vfs/tar-reader.js';
import {
  buildTar,
  extensionBlock,
  fixChecksum,
  pad512,
  paxBody,
  tarHeader,
} from './tar-fixture.test-support.js';

const END = Buffer.alloc(1024);

/** 바이트를 chunkSize 단위로 쪼개 주는 Readable. chunk 경계 사례용이다. */
function chunked(bytes: Buffer, chunkSize = bytes.length): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
  return Readable.from(chunks);
}

/** 헤더 + 본문 + padding. 끝 블록은 붙이지 않는다. */
function entryBlock(
  name: string,
  body: Buffer = Buffer.alloc(0),
  type = '0',
  options: Parameters<typeof tarHeader>[3] = {},
): Buffer {
  return Buffer.concat([tarHeader(name, body.length, type, options), body, pad512(body)]);
}

/** 모든 entry를 모은다. drain=false면 FILE 본문을 열지 않는다. */
async function collect(
  tar: Buffer,
  options: { drain?: boolean; chunkSize?: number; signal?: AbortSignal; maxHeaderBytes?: number } = {},
) {
  const source = chunked(tar, options.chunkSize);
  const out: { name: string; type: string; size: bigint; body?: Buffer }[] = [];
  for await (const entry of readTarEntries(source, {
    maxHeaderBytes: options.maxHeaderBytes ?? 65536,
    signal: options.signal ?? new AbortController().signal,
  })) {
    const item: (typeof out)[number] = { name: entry.name, type: entry.type, size: entry.size };
    if (options.drain !== false && entry.type === 'FILE') {
      const chunks: Buffer[] = [];
      for await (const chunk of await entry.open()) chunks.push(chunk as Buffer);
      item.body = Buffer.concat(chunks);
    }
    out.push(item);
  }
  return { out, source };
}

describe('readTarEntries 정상 입력', () => {
  it('FILE·빈 DIRECTORY·0-byte FILE을 순서대로 돌려주고 chunk 경계와 무관하다', async () => {
    const tar = buildTar([
      { name: 'dir/', type: '5' },
      { name: 'dir/a.txt', body: Buffer.from('hello') },
      { name: 'zero' },
      { name: 'b.bin', body: Buffer.alloc(600, 7) },
    ]);
    for (const chunkSize of [tar.length, 512, 100, 7]) {
      const { out, source } = await collect(tar, { chunkSize });
      expect(out.map((e) => [e.name, e.type, e.size])).toEqual([
        ['dir/', 'DIRECTORY', 0n],
        ['dir/a.txt', 'FILE', 5n],
        ['zero', 'FILE', 0n],
        ['b.bin', 'FILE', 600n],
      ]);
      expect(out[1].body?.toString()).toBe('hello');
      expect(out[3].body).toEqual(Buffer.alloc(600, 7));
      expect(source.destroyed).toBe(true);
    }
  });

  it('열지 않은 FILE 본문은 다음 entry 전에 drain한다', async () => {
    const tar = buildTar([
      { name: 'a', body: Buffer.alloc(1300, 1) },
      { name: 'b', body: Buffer.from('bb') },
      { name: 'c', body: Buffer.alloc(513, 3) },
    ]);
    for (const chunkSize of [tar.length, 100]) {
      const { out } = await collect(tar, { drain: false, chunkSize });
      expect(out.map((e) => [e.name, e.size])).toEqual([
        ['a', 1300n],
        ['b', 2n],
        ['c', 513n],
      ]);
    }
  });

  it('ustar prefix를 이름 앞에 붙이고 한글 이름을 UTF-8로 읽는다', async () => {
    const tar = buildTar([
      { name: 'file.txt', prefix: 'deep/dir', body: Buffer.from('x') },
      { name: '한글.txt', prefix: '폴더' },
    ]);
    const { out } = await collect(tar);
    expect(out.map((e) => e.name)).toEqual(['deep/dir/file.txt', '폴더/한글.txt']);
  });

  it('typeflag NUL은 일반 FILE, 이름이 /로 끝나는 typeflag 0은 DIRECTORY다', async () => {
    const nul = tarHeader('legacy', 2, '0');
    nul[156] = 0;
    fixChecksum(nul);
    const tar = Buffer.concat([nul, Buffer.from('ok'), pad512(Buffer.from('ok')), entryBlock('slash/'), END]);
    const { out } = await collect(tar);
    expect(out.map((e) => [e.name, e.type, e.body?.toString()])).toEqual([
      ['legacy', 'FILE', 'ok'],
      ['slash/', 'DIRECTORY', undefined],
    ]);
  });

  it('GNU magic(ustar 뒤 공백)은 prefix 영역을 이름에 쓰지 않고 base-256 크기를 읽는다', async () => {
    const header = tarHeader('gnu.txt', 0, '0');
    header.write('ustar  \0', 257, 8, 'ascii');
    header.write('ignored-prefix', 345, 'ascii');
    header[124] = 0x80;
    header.fill(0, 125, 135);
    header[135] = 5;
    fixChecksum(header);
    const body = Buffer.from('12345');
    const { out } = await collect(Buffer.concat([header, body, pad512(body), END]));
    expect(out).toEqual([{ name: 'gnu.txt', type: 'FILE', size: 5n, body }]);
  });

  it('끝 블록 뒤 zero padding과 빈 archive를 허용한다', async () => {
    const padded = Buffer.concat([
      buildTar([{ name: 'a', body: Buffer.from('x') }]),
      Buffer.alloc(10240 - 2048),
    ]);
    expect((await collect(padded, { chunkSize: 1000 })).out.map((e) => e.name)).toEqual(['a']);
    expect((await collect(END)).out).toEqual([]);
    expect((await collect(buildTar([]))).out).toEqual([]);
  });
});

describe('readTarEntries 확장 헤더', () => {
  it('PAX g 전역값은 뒤 entry에 적용되고 x는 다음 entry에만 적용된다', async () => {
    const g = paxBody({ path: 'global/name' });
    const x = paxBody({ path: '한글/경로.txt', size: '3' });
    const tar = Buffer.concat([
      extensionBlock('g', g),
      entryBlock('first', Buffer.from('a')),
      extensionBlock('x', x),
      entryBlock('second', Buffer.from('abc')),
      entryBlock('third'),
      END,
    ]);
    const { out } = await collect(tar);
    expect(out.map((e) => e.name)).toEqual(['global/name', '한글/경로.txt', 'global/name']);
  });

  it('PAX x의 path와 size가 헤더 값보다 우선하고 레코드 길이는 UTF-8 byte 기준이다', async () => {
    const x = paxBody({ path: '가나다/라마바사.txt', size: '3' });
    expect(x.toString('utf8')).toContain('가나다/라마바사.txt');
    const header = tarHeader('placeholder', 1, '0');
    const body = Buffer.from('abc');
    const tar = Buffer.concat([extensionBlock('x', x), header, body, pad512(body), END]);
    const { out } = await collect(tar, { chunkSize: 300 });
    expect(out).toEqual([{ name: '가나다/라마바사.txt', type: 'FILE', size: 3n, body }]);
  });

  it('GNU longname L은 다음 entry 이름을 대신한다', async () => {
    const longName = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}.txt`;
    const nameBytes = Buffer.from(`${longName}\0`);
    const tar = Buffer.concat([
      extensionBlock('L', nameBytes),
      entryBlock('truncated-name', Buffer.from('x')),
      END,
    ]);
    const { out } = await collect(tar);
    expect(out.map((e) => e.name)).toEqual([longName]);
  });

  it('PAX 헤더 본문이 maxHeaderBytes를 넘으면 entry 오류다', async () => {
    const x = paxBody({ path: 'p'.repeat(200) });
    const tar = Buffer.concat([extensionBlock('x', x), entryBlock('a'), END]);
    await expect(collect(tar, { maxHeaderBytes: 64 })).rejects.toMatchObject({ kind: 'entry' });
    await expect(collect(tar, { maxHeaderBytes: 65536 })).resolves.toBeDefined();
  });

  it('잘못된 PAX 길이·개행·= 누락·UTF-8은 entry 오류다', async () => {
    const bodies = [
      Buffer.from('5 a=b\n'),
      Buffer.from('99 path=a\n'),
      Buffer.from('abc path=a\n'),
      Buffer.from('8 pathx\n'),
      Buffer.concat([Buffer.from('12 path='), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('\n')]),
    ];
    for (const body of bodies) {
      const tar = Buffer.concat([extensionBlock('x', body), entryBlock('a'), END]);
      await expect(collect(tar)).rejects.toMatchObject({ kind: 'entry' });
    }
  });

  it('GNU.sparse와 SCHILY.realsize PAX는 이름을 담은 entry 오류다', async () => {
    const variants: Record<string, string>[] = [
      { 'GNU.sparse.major': '1', path: 'sp' },
      { 'SCHILY.realsize': '10', path: 'sp' },
      // GNU tar는 실제 경로를 GNU.sparse.name에 두고 path에는 자리 표시 이름을 쓴다.
      { 'GNU.sparse.major': '1', 'GNU.sparse.name': 'sp', path: './PaxHeaders/sp' },
    ];
    for (const records of variants) {
      const x = paxBody(records);
      const tar = Buffer.concat([extensionBlock('x', x), entryBlock('sp'), END]);
      await expect(collect(tar)).rejects.toMatchObject({ kind: 'entry', entryName: 'sp' });
    }
  });
});

describe('readTarEntries 거부 입력', () => {
  it('link·장치·FIFO·GNU S·longlink·contiguous는 이름을 담은 entry 오류다', async () => {
    for (const type of ['1', '2', '3', '4', '6', '7', 'S', 'K'] as const) {
      await expect(collect(buildTar([{ name: 'bad', type, linkName: '/etc/passwd' }]))).rejects.toMatchObject(
        {
          kind: 'entry',
          entryName: 'bad',
        },
      );
    }
  });

  it('DIRECTORY entry에 본문이 있으면 entry 오류다', async () => {
    const body = Buffer.from('x');
    await expect(collect(Buffer.concat([entryBlock('d/', body, '5'), END]))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'd/',
    });
    await expect(collect(Buffer.concat([entryBlock('d/', body, '0'), END]))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'd/',
    });
  });

  it('V7 헤더는 형식 오류다', async () => {
    await expect(collect(buildTar([{ name: 'a', ustar: false }]))).rejects.toMatchObject({ kind: 'format' });
  });

  it('tar가 아닌 내용은 길이와 무관하게 형식 오류다', async () => {
    await expect(collect(Buffer.alloc(1024, 0x41))).rejects.toMatchObject({ kind: 'format' });
    await expect(collect(Buffer.from('hello'))).rejects.toMatchObject({ kind: 'format' });
    await expect(collect(Buffer.alloc(0))).rejects.toMatchObject({ kind: 'format' });
  });

  it('잘린 본문·padding·헤더는 entry 오류이고 본문 오류는 소비자에게 전달된다', async () => {
    const full = buildTar([{ name: 'a', body: Buffer.alloc(600, 1) }]);
    await expect(collect(full.subarray(0, 700))).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
    await expect(collect(full.subarray(0, 512 + 600 + 5))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'a',
    });
    await expect(collect(full.subarray(0, 700), { drain: false })).rejects.toMatchObject({ kind: 'entry' });
    const twoEntries = buildTar([{ name: 'a' }, { name: 'b' }]);
    await expect(collect(twoEntries.subarray(0, 512 + 100))).rejects.toMatchObject({
      kind: 'entry',
      entryName: '',
    });
  });

  it('ustar magic이 있는 채 첫 헤더가 잘리면 entry 오류다', async () => {
    const full = buildTar([{ name: 'a' }]);
    await expect(collect(full.subarray(0, 300))).rejects.toMatchObject({ kind: 'entry' });
  });

  it('checksum 오류와 8진수가 아닌 숫자 필드는 entry 오류다', async () => {
    const bad = buildTar([{ name: 'a' }]);
    bad[148] = bad[148] === 0x37 ? 0x30 : 0x37;
    await expect(collect(bad)).rejects.toMatchObject({ kind: 'entry' });
    const header = tarHeader('a', 0, '0');
    header.write('12x4567\0', 124, 8, 'ascii');
    fixChecksum(header);
    await expect(collect(Buffer.concat([header, END]))).rejects.toMatchObject({ kind: 'entry' });
  });

  it('UTF-8이 아닌 entry 이름은 entry 오류다', async () => {
    const header = tarHeader('x', 0, '0', { rawName: Buffer.from([0xff, 0xfe, 0x61]) });
    await expect(collect(Buffer.concat([header, END]))).rejects.toMatchObject({ kind: 'entry' });
  });
});

describe('readTarEntries 끝 블록', () => {
  it('끝 블록 하나만 있거나 없으면 마지막 entry 이름을 담은 entry 오류다', async () => {
    const full = buildTar([{ name: 'a', body: Buffer.from('x') }]);
    await expect(collect(full.subarray(0, full.length - 512))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'a',
    });
    await expect(collect(full.subarray(0, full.length - 1024))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'a',
    });
    await expect(collect(END.subarray(0, 512))).rejects.toMatchObject({ kind: 'entry' });
  });

  it('끝 표시 뒤 nonzero 데이터는 entry 오류다', async () => {
    const full = buildTar([{ name: 'a' }]);
    await expect(collect(Buffer.concat([full, Buffer.from('junk')]))).rejects.toMatchObject({
      kind: 'entry',
    });
    const late = Buffer.concat([full, Buffer.alloc(4096), Buffer.from([1])]);
    await expect(collect(late, { chunkSize: 1000 })).rejects.toMatchObject({ kind: 'entry' });
    await expect(
      collect(Buffer.concat([full.subarray(0, 512), Buffer.alloc(512), entryBlock('b'), END])),
    ).rejects.toMatchObject({ kind: 'entry' });
  });

  it('확장 헤더 뒤 entry 없이 끝나면 확장 헤더가 지정한 이름을 담은 entry 오류다', async () => {
    const x = paxBody({ path: 'dangling' });
    await expect(collect(Buffer.concat([extensionBlock('x', x), END]))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'dangling',
    });
    await expect(collect(extensionBlock('x', x))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'dangling',
    });
  });
});

describe('readTarEntries source 소유권', () => {
  it('대기 중인 next()를 취소하면 source를 즉시 닫고 취소 사유로 실패한다', async () => {
    const controller = new AbortController();
    const source = new Readable({ read() {} });
    source.push(buildTar([{ name: 'a' }]).subarray(0, 100));
    const iterator = readTarEntries(source, { maxHeaderBytes: 65536, signal: controller.signal });
    const pending = iterator.next();
    pending.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    expect(source.destroyed).toBe(true);
  });

  it('취소되면 열린 본문 읽기가 실패하고 source를 destroy하며 open 두 번은 거부한다', async () => {
    const controller = new AbortController();
    const tar = buildTar([
      { name: 'a', body: Buffer.from('x') },
      { name: 'b', body: Buffer.from('y') },
    ]);
    const source = chunked(tar, 64);
    const iterator = readTarEntries(source, { maxHeaderBytes: 65536, signal: controller.signal });
    const first = await iterator.next();
    await first.value.open();
    await expect(first.value.open()).rejects.toThrow(/opened twice/);
    controller.abort(new Error('stop'));
    await expect(iterator.next()).rejects.toThrow('stop');
    expect(source.destroyed).toBe(true);
  });

  it('소비자가 조기에 return하면 source를 destroy하고 close를 기다린다', async () => {
    const source = chunked(buildTar([{ name: 'a' }, { name: 'b' }]), 64);
    const iterator = readTarEntries(source, { maxHeaderBytes: 65536, signal: new AbortController().signal });
    await iterator.next();
    await iterator.return(undefined);
    expect(source.destroyed).toBe(true);
    expect(source.closed).toBe(true);
  });

  it('source 오류는 형식 오류로 바꾸지 않고 그대로 전파한다', async () => {
    const source = new Readable({ read() {} });
    source.push(buildTar([{ name: 'a' }]).subarray(0, 600));
    const iterator = readTarEntries(source, { maxHeaderBytes: 65536, signal: new AbortController().signal });
    await iterator.next();
    const result = iterator.next();
    const failure = result.then(
      () => null,
      (error: unknown) => error,
    );
    source.destroy(new Error('S3 down'));
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExtractReaderError);
    expect((error as Error).message).toBe('S3 down');
  });

  it('이미 취소된 signal로 시작하면 첫 읽기에서 실패하고 source를 닫는다', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already'));
    const source = chunked(buildTar([{ name: 'a' }]));
    const iterator = readTarEntries(source, { maxHeaderBytes: 65536, signal: controller.signal });
    await expect(iterator.next()).rejects.toThrow('already');
    expect(source.destroyed).toBe(true);
  });
});
