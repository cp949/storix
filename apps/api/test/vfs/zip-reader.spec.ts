/**
 * ZIP32 reader의 entry 열거·본문 해제·metadata 대조·거부 사례·range 호출·stream 소유권을 검증한다.
 * 메모리 안의 Buffer range와 직접 만든 ZIP 바이트를 쓴다.
 * 규칙은 docs/design/17-file-extract.md "실행"과 "공개 계약"을 따른다.
 */
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { ExtractReaderError } from '../../src/vfs/extract-reader-error.js';
import { readZipEntries } from '../../src/vfs/zip-reader.js';
import { bufferRanges, buildZip, centralDirectoryOffset, handZip } from './zip-fixture.test-support.js';

/** 해제한 본문을 모아 fixture의 평문과 대조한다. */
async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** 모든 entry를 모은다. open=false면 본문을 열지 않는다. */
async function collect(zip: Buffer, open = true, chunkSize = 64) {
  const out: {
    name: string;
    type: string;
    size: bigint;
    compressedSize: bigint | null;
    body?: Buffer;
  }[] = [];
  for await (const entry of readZipEntries({
    ...bufferRanges(zip, chunkSize),
    signal: new AbortController().signal,
  })) {
    const item: (typeof out)[number] = {
      name: entry.name,
      type: entry.type,
      size: entry.size,
      compressedSize: entry.compressedSize,
    };
    if (open && entry.type === 'FILE') item.body = await toBuffer(await entry.open());
    out.push(item);
  }
  return out;
}

/** 첫 entry만 꺼낸다. stream 소유권 사례에서 본문을 직접 다룰 때 쓴다. */
async function firstEntry(
  zip: Buffer,
  overrides: Partial<ReturnType<typeof bufferRanges>> = {},
  signal?: AbortSignal,
) {
  const iterator = readZipEntries({
    ...bufferRanges(zip),
    ...overrides,
    signal: signal ?? new AbortController().signal,
  });
  const first = await iterator.next();
  return first.value!;
}

/** EOCD record의 offset이다. */
const eocdOffset = (zip: Buffer) => zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

describe('readZipEntries 정상 입력', () => {
  it('Storix writer 출력(DEFLATE·signed descriptor·UTF-8)을 round-trip한다', async () => {
    const zip = await buildZip([
      { name: '한글/b.txt', body: Buffer.from('hello zip') },
      { name: 'c.bin', body: Buffer.alloc(5000, 3) },
      { name: 'empty', body: Buffer.alloc(0) },
    ]);
    for (const chunkSize of [7, 64, 100000]) {
      const out = await collect(zip, true, chunkSize);
      expect(out.map((e) => [e.name, e.type, e.size])).toEqual([
        ['한글/b.txt', 'FILE', 9n],
        ['c.bin', 'FILE', 5000n],
        ['empty', 'FILE', 0n],
      ]);
      expect(out[0].body?.toString()).toBe('hello zip');
      expect(out[1].body).toEqual(Buffer.alloc(5000, 3));
      expect(out[2].body?.length).toBe(0);
    }
  });

  it('Storix writer의 STORED 출력도 읽는다', async () => {
    const zip = await buildZip([{ name: 'a.txt', body: Buffer.from('stored body') }], 0);
    expect((await collect(zip))[0].body?.toString()).toBe('stored body');
  });

  it('STORED·unsigned descriptor·DIRECTORY·comment를 읽는다', async () => {
    const zip = handZip(
      [
        { name: 'dir/' },
        { name: 'a', body: Buffer.from('abc'), descriptor: 'unsigned' },
        { name: 'b', body: Buffer.from('xyz'), method: 8 },
      ],
      { comment: Buffer.from('c'.repeat(100)) },
    );
    expect(await collect(zip)).toMatchObject([
      { name: 'dir/', type: 'DIRECTORY', size: 0n },
      { name: 'a', size: 3n, body: Buffer.from('abc') },
      { name: 'b', size: 3n, body: Buffer.from('xyz') },
    ]);
  });

  it('local header가 실제 값을 담은 bit 3 entry와 DEFLATE로 저장된 빈 DIRECTORY도 읽는다', async () => {
    const body = Buffer.from('real');
    const zip = handZip([
      { name: 'javadir/', method: 8 },
      { name: 'f', body, descriptor: 'signed', localOverride: { compressedSize: 4, uncompressedSize: 4 } },
    ]);
    const out = await collect(zip);
    expect(out.map((e) => [e.name, e.type])).toEqual([
      ['javadir/', 'DIRECTORY'],
      ['f', 'FILE'],
    ]);
    expect(out[1].body).toEqual(body);
  });

  it('central과 다른 길이의 extra와 알려진 extra TLV는 무시한다', async () => {
    const timestamp = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x01, 0x02, 0x03, 0x04]);
    const zip = handZip([{ name: 'a', body: Buffer.from('x'), extra: timestamp }]);
    expect((await collect(zip))[0].body?.toString()).toBe('x');
  });

  it('EOCD comment 안의 가짜 EOCD signature는 건너뛴다', async () => {
    const fake = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(18),
      Buffer.from('tail'),
    ]);
    const zip = handZip([{ name: 'a', body: Buffer.from('x') }], { comment: fake });
    expect((await collect(zip)).map((e) => e.name)).toEqual(['a']);
  });

  it('빈 ZIP을 읽는다', async () => {
    expect(await collect(handZip([]))).toEqual([]);
  });

  it('central directory를 64 KiB 창으로 읽어 record마다 GET하지 않는다', async () => {
    const entries = Array.from({ length: 3000 }, (_, i) => ({
      name: `dir/subdir/file-${String(i).padStart(5, '0')}.txt`,
    }));
    const zip = handZip(entries);
    const ranges = bufferRanges(zip);
    const names: string[] = [];
    for await (const entry of readZipEntries({ ...ranges, signal: new AbortController().signal }))
      names.push(entry.name);
    expect(names).toHaveLength(3000);
    expect(names[2999]).toBe('dir/subdir/file-02999.txt');
    const cdStart = BigInt(centralDirectoryOffset(zip));
    expect(ranges.calls.read.filter(([start]) => start >= cdStart).length).toBeLessThanOrEqual(8);
    expect(Math.max(...ranges.calls.read.map(([, length]) => length))).toBeLessThanOrEqual(70000);
  });
});

describe('readZipEntries local header·descriptor 대조', () => {
  it('bit 3이 없을 때 local CRC·크기가 central과 다르면 entry 오류다', async () => {
    for (const localOverride of [{ crc: 1 }, { compressedSize: 9 }, { uncompressedSize: 9 }]) {
      const zip = handZip([{ name: 'a', body: Buffer.from('abc'), localOverride }]);
      await expect(collect(zip)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
    }
  });

  it('bit 3 entry의 local 값이 0도 central 값도 아니면 entry 오류이고 central 값이면 허용한다', async () => {
    const body = Buffer.from('abc');
    await expect(
      collect(handZip([{ name: 'a', body, descriptor: 'signed', localOverride: { crc: 7 } }])),
    ).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
    await expect(
      collect(handZip([{ name: 'a', body, descriptor: 'unsigned', localOverride: { uncompressedSize: 3 } }])),
    ).resolves.toHaveLength(1);
  });

  it('local flags·method·이름이 central과 다르면 entry 오류다', async () => {
    const flags = handZip([{ name: 'ab', body: Buffer.from('x') }]);
    flags.writeUInt16LE(0x0800, 6);
    await expect(collect(flags)).rejects.toMatchObject({ kind: 'entry', entryName: 'ab' });
    const method = handZip([{ name: 'ab', body: Buffer.from('x') }]);
    method.writeUInt16LE(8, 8);
    await expect(collect(method)).rejects.toMatchObject({ kind: 'entry', entryName: 'ab' });
    const name = handZip([{ name: 'ab', body: Buffer.from('x') }]);
    name.write('zz', 30, 2, 'ascii');
    await expect(collect(name)).rejects.toMatchObject({ kind: 'entry' });
    const nameLength = handZip([{ name: 'ab', body: Buffer.from('x') }]);
    nameLength.writeUInt16LE(3, 26);
    await expect(collect(nameLength)).rejects.toMatchObject({ kind: 'entry', entryName: 'ab' });
  });

  it('local signature가 없거나 local header offset이 FILE 밖이면 entry 오류다', async () => {
    const signature = handZip([{ name: 'a', body: Buffer.from('x') }]);
    signature.writeUInt32LE(0, 0);
    await expect(collect(signature)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
    const outside = handZip([{ name: 'a', body: Buffer.from('x') }]);
    outside.writeUInt32LE(0x7fffffff, centralDirectoryOffset(outside) + 42);
    await expect(collect(outside)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
  });

  it('본문 범위가 central directory와 겹치면 entry 오류다', async () => {
    const zip = handZip([{ name: 'a', body: Buffer.from('abc'), compressedSize: 10 }]);
    await expect(collect(zip, false)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
  });

  it('descriptor의 CRC·크기가 central과 다르면 순회 중 entry 오류다', async () => {
    for (const kind of ['signed', 'unsigned'] as const) {
      for (const descriptorOverride of [{ crc: 1 }, { compressedSize: 9 }, { uncompressedSize: 9 }]) {
        const zip = handZip([{ name: 'a', body: Buffer.from('abc'), descriptor: kind, descriptorOverride }]);
        await expect(collect(zip, false)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
      }
    }
  });

  it.each(['skip.txt', 'folder/'])('본문을 열지 않는 %s도 손상 descriptor를 거부한다', async (name) => {
    const zip = handZip([{ name, descriptor: 'signed', descriptorOverride: { crc: 1 } }]);
    await expect(collect(zip, false)).rejects.toMatchObject({ kind: 'entry', entryName: name });
  });

  it('descriptor가 12 byte보다 짧거나 16 byte signed가 12 byte로 잘렸으면 순회 중 entry 오류다', async () => {
    const zip = handZip([{ name: 'a', body: Buffer.from('abc'), descriptor: 'signed' }]);
    const cd = centralDirectoryOffset(zip);
    const cutBy = (bytes: number): Buffer => {
      const cut = Buffer.concat([zip.subarray(0, cd - bytes), zip.subarray(cd)]);
      cut.writeUInt32LE(cd - bytes, eocdOffset(cut) + 16);
      return cut;
    };
    await expect(collect(cutBy(8))).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
    await expect(collect(cutBy(4), false)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
  });
});

describe('readZipEntries 본문 무결성', () => {
  it('central CRC 불일치는 본문을 읽는 중 entry 오류다', async () => {
    const zip = handZip([{ name: 'a', body: Buffer.from('abc'), crc: 1 }]);
    await expect(collect(zip)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
  });

  it('실제 평문이 선언보다 길거나 짧으면 entry 오류다', async () => {
    const longer = handZip([{ name: 'a', body: Buffer.from('abcd'), uncompressedSize: 3 }]);
    await expect(collect(longer)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
    const shorter = handZip([{ name: 'a', body: Buffer.from('abcd'), uncompressedSize: 5 }]);
    await expect(collect(shorter)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
  });

  it('DEFLATE 데이터 손상은 entry 오류다', async () => {
    const zip = handZip([{ name: 'a', body: Buffer.alloc(3000, 1), method: 8 }]);
    zip[33] ^= 0xff;
    await expect(collect(zip)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
    const truncated = handZip([
      { name: 'a', body: Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 37) % 251)), method: 8 },
    ]);
    const cd = centralDirectoryOffset(truncated);
    // 압축 데이터 뒤쪽을 central과 같은 크기로 유지한 채 0으로 덮어 inflate가 끝나지 않게 한다.
    truncated.fill(0xff, cd - 20, cd);
    await expect(collect(truncated)).rejects.toMatchObject({ kind: 'entry', entryName: 'a' });
  });

  it('DIRECTORY entry의 평문 크기가 0이 아니면 entry 오류다', async () => {
    await expect(collect(handZip([{ name: 'd/', body: Buffer.from('x') }]))).rejects.toMatchObject({
      kind: 'entry',
      entryName: 'd/',
    });
  });
});

describe('readZipEntries 형식 거부', () => {
  it('암호화·zip64·multi-disk·미지원 method는 형식 오류다', async () => {
    const cases: Buffer[] = [
      handZip([{ name: 'a', body: Buffer.from('a'), flags: 1 }]),
      handZip([{ name: 'a', body: Buffer.from('a'), flags: 0x40 }]),
      handZip([{ name: 'a', body: Buffer.from('a'), flags: 0x2000 }]),
      handZip([{ name: 'a', body: Buffer.from('a'), uncompressedSize: 0xffffffff }]),
      handZip([{ name: 'a', body: Buffer.from('a'), compressedSize: 0xffffffff }]),
      handZip([{ name: 'a', body: Buffer.from('a'), extra: Buffer.from([1, 0, 0, 0]) }]),
      handZip([{ name: 'a', body: Buffer.from('a') }], { diskNumber: 1 }),
      handZip([{ name: 'a', body: Buffer.from('a'), method: 12 }]),
      handZip([{ name: 'a', body: Buffer.from('a'), method: 99 }]),
    ];
    for (const zip of cases) await expect(collect(zip)).rejects.toMatchObject({ kind: 'format' });
    const localOffset = handZip([{ name: 'a', body: Buffer.from('a') }]);
    localOffset.writeUInt32LE(0xffffffff, centralDirectoryOffset(localOffset) + 42);
    await expect(collect(localOffset)).rejects.toMatchObject({ kind: 'format' });
    const entryDisk = handZip([{ name: 'a', body: Buffer.from('a') }]);
    entryDisk.writeUInt16LE(1, centralDirectoryOffset(entryDisk) + 34);
    await expect(collect(entryDisk)).rejects.toMatchObject({ kind: 'format' });
  });

  it('symlink 속성은 이름을 담은 entry 오류다', async () => {
    const zip = handZip([
      { name: 'ln', body: Buffer.from('/etc/passwd'), madeBy: 0x031e, external: 0xa1ff0000 },
    ]);
    await expect(collect(zip)).rejects.toMatchObject({ kind: 'entry', entryName: 'ln' });
    const regular = handZip([{ name: 'f', body: Buffer.from('x'), madeBy: 0x031e, external: 0x81a40000 }]);
    await expect(collect(regular)).resolves.toHaveLength(1);
  });

  it('UTF-8이 아닌 entry 이름은 entry 오류다', async () => {
    const zip = handZip([{ name: 'ab', body: Buffer.from('x') }]);
    const cd = centralDirectoryOffset(zip);
    zip.writeUInt8(0xff, cd + 46);
    zip.writeUInt8(0xff, 30);
    await expect(collect(zip)).rejects.toMatchObject({ kind: 'entry' });
  });

  it('EOCD가 없거나 짧으면 entry 오류다', async () => {
    await expect(collect(Buffer.alloc(100))).rejects.toMatchObject({ kind: 'entry', entryName: '' });
    await expect(collect(Buffer.alloc(10))).rejects.toMatchObject({ kind: 'entry', entryName: '' });
  });

  it('EOCD 필드가 서로 맞지 않으면 entry 오류이고 zip64 sentinel은 형식 오류다', async () => {
    await expect(collect(handZip([{ name: 'a' }], { cdEntriesOverride: 2 }))).rejects.toMatchObject({
      kind: 'entry',
      entryName: '',
    });
    const sentinel = handZip([{ name: 'a' }]);
    sentinel.writeUInt16LE(0xffff, eocdOffset(sentinel) + 10);
    sentinel.writeUInt16LE(0xffff, eocdOffset(sentinel) + 8);
    await expect(collect(sentinel)).rejects.toMatchObject({ kind: 'format' });
    const shifted = handZip([{ name: 'a', body: Buffer.from('x') }]);
    shifted.writeUInt32LE(shifted.length, eocdOffset(shifted) + 16);
    await expect(collect(shifted)).rejects.toMatchObject({ kind: 'entry', entryName: '' });
    const size = handZip([{ name: 'a', body: Buffer.from('x') }]);
    size.writeUInt32LE(size.readUInt32LE(eocdOffset(size) + 12) - 1, eocdOffset(size) + 12);
    await expect(collect(size)).rejects.toMatchObject({ kind: 'entry', entryName: '' });
  });

  it('entry 수가 central directory record 수와 다르면 entry 오류다', async () => {
    const more = handZip([{ name: 'a', body: Buffer.from('x') }]);
    more.writeUInt16LE(2, eocdOffset(more) + 8);
    more.writeUInt16LE(2, eocdOffset(more) + 10);
    await expect(collect(more)).rejects.toMatchObject({ kind: 'entry', entryName: '' });
    const fewer = handZip([{ name: 'a', body: Buffer.from('x') }]);
    fewer.writeUInt16LE(0, eocdOffset(fewer) + 8);
    fewer.writeUInt16LE(0, eocdOffset(fewer) + 10);
    await expect(collect(fewer)).rejects.toMatchObject({ kind: 'entry', entryName: '' });
  });

  it('central record의 가변 필드·extra TLV·signature 손상은 entry 오류다', async () => {
    const name = handZip([{ name: 'a', body: Buffer.from('x') }]);
    name.writeUInt16LE(5000, centralDirectoryOffset(name) + 28);
    await expect(collect(name)).rejects.toMatchObject({ kind: 'entry', entryName: '' });
    const extra = handZip([
      { name: 'a', body: Buffer.from('x'), extra: Buffer.from([0x99, 0x00, 0x05, 0x00, 0x01]) },
    ]);
    await expect(collect(extra)).rejects.toMatchObject({ kind: 'entry', entryName: '' });
    const signature = handZip([{ name: 'a', body: Buffer.from('x') }]);
    signature.writeUInt32LE(0, centralDirectoryOffset(signature));
    await expect(collect(signature)).rejects.toMatchObject({ kind: 'entry', entryName: '' });
  });
});

describe('readZipEntries range 호출과 stream 소유권', () => {
  it('0-byte FILE은 openRange를 부르지 않고 open 두 번은 거부한다', async () => {
    const ranges = bufferRanges(handZip([{ name: 'z' }]));
    const openRange = jest.fn(ranges.openRange);
    const seen: string[] = [];
    for await (const entry of readZipEntries({
      ...ranges,
      openRange,
      signal: new AbortController().signal,
    })) {
      seen.push(entry.name);
      expect((await toBuffer(await entry.open())).length).toBe(0);
      await expect(entry.open()).rejects.toThrow(/opened twice/);
    }
    expect(seen).toEqual(['z']);
    expect(openRange).not.toHaveBeenCalled();
    expect(ranges.calls.read.every(([, length]) => length > 0)).toBe(true);
  });

  it('본문을 열지 않은 FILE은 local header만 읽고 본문 range는 열지 않는다', async () => {
    const zip = handZip([{ name: 'a', body: Buffer.from('abc') }]);
    const ranges = bufferRanges(zip);
    const names: string[] = [];
    for await (const entry of readZipEntries({ ...ranges, signal: new AbortController().signal }))
      names.push(entry.name);
    expect(names).toEqual(['a']);
    expect(ranges.calls.open).toEqual([]);
  });

  it('storage 오류는 형식 오류로 바꾸지 않고 그대로 전파한다', async () => {
    const zip = handZip([{ name: 'a', body: Buffer.from('x') }]);
    const entry = await firstEntry(zip, {
      openRange: async () => {
        throw new Error('S3 down');
      },
    });
    await expect(entry.open()).rejects.toThrow('S3 down');
    await expect(entry.open()).rejects.toThrow(/opened twice/);
    await expect(
      (async () => {
        const entries = readZipEntries({
          ...bufferRanges(zip),
          readRange: async () => {
            throw new Error('S3 down');
          },
          signal: new AbortController().signal,
        });
        await entries.next();
      })(),
    ).rejects.toThrow('S3 down');
  });

  it('본문 stream 중간의 storage 오류와 짧은 range 응답은 형식 오류가 아닌 일반 오류다', async () => {
    const body = Buffer.alloc(2000, 5);
    const zip = handZip([{ name: 'a', body, method: 8 }]);
    const short = await firstEntry(zip, {
      // 실제 압축 바이트의 앞부분만 돌려줘 inflate가 아닌 길이 확인이 먼저 실패하게 한다.
      openRange: async (start, length) =>
        Readable.from([zip.subarray(Number(start), Number(start) + length - 3)]),
    });
    const shortError = await toBuffer(await short.open()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(shortError).toBeInstanceOf(Error);
    expect(shortError).not.toBeInstanceOf(ExtractReaderError);
    const broken = await firstEntry(zip, {
      openRange: async () =>
        new Readable({
          read() {
            this.destroy(new Error('socket reset'));
          },
        }),
    });
    const brokenError = await toBuffer(await broken.open()).then(
      () => null,
      (error: unknown) => error,
    );
    expect((brokenError as Error).message).toBe('socket reset');
    expect(brokenError).not.toBeInstanceOf(ExtractReaderError);
  });

  it('본문 stream을 destroy하면 range stream까지 닫고 close 이벤트는 그 뒤에 온다', async () => {
    const zip = handZip([{ name: 'a', body: Buffer.alloc(1000, 1), method: 8 }]);
    const raw = new Readable({ read() {} });
    const entry = await firstEntry(zip, { openRange: async () => raw });
    const out = await entry.open();
    out.on('error', () => undefined);
    out.destroy();
    await new Promise((resolve) => out.once('close', resolve));
    expect(raw.destroyed).toBe(true);
    expect(raw.closed).toBe(true);
  });

  it('열린 본문 읽기 중 취소하면 취소 사유로 실패하고 range stream을 닫는다', async () => {
    const controller = new AbortController();
    const zip = handZip([{ name: 'a', body: Buffer.alloc(1000, 1), method: 8 }]);
    const raw = new Readable({ read() {} });
    const entry = await firstEntry(zip, { openRange: async () => raw }, controller.signal);
    const out = await entry.open();
    const reading = toBuffer(out).then(
      () => null,
      (error: unknown) => error,
    );
    controller.abort(new Error('stop'));
    expect(((await reading) as Error).message).toBe('stop');
    await new Promise((resolve) => (out.closed ? resolve(undefined) : out.once('close', resolve)));
    expect(raw.destroyed).toBe(true);
    expect(raw.closed).toBe(true);
  });

  it('open 전에 이미 취소됐으면 range를 열지 않고 취소 사유로 실패한다', async () => {
    const controller = new AbortController();
    const zip = handZip([{ name: 'a', body: Buffer.from('abc') }]);
    const ranges = bufferRanges(zip);
    const entry = await firstEntry(zip, { ...ranges }, controller.signal);
    controller.abort(new Error('stop'));
    await expect(entry.open()).rejects.toThrow('stop');
    expect(ranges.calls.open).toEqual([]);
  });
});
