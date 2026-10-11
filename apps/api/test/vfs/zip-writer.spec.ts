// ZIP writer의 외부 호환성과 stream 수명을 실제 stream으로 검증한다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZipWriter, toZip32Number } from '../../src/vfs/zip-writer.js';

function* chunked(buffer: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}

// 외부 reader와 실제 stream으로 형식 호환·취소 시 소유 자원 종료를 확인한다.
describe('ZIP stream 작성기', () => {
  it.each([0, 1, 6])('level %i로 한글·공백·빈 파일을 외부 reader에서 연다', async (compressionLevel) => {
    const entries = [
      { name: '한글 폴더/공백 file.txt', modifiedAt: new Date('2024-03-04T05:06:07Z') },
      { name: 'empty', modifiedAt: new Date('2024-03-04T05:06:07Z') },
      { name: `long-${'이름'.repeat(40)}.bin`, modifiedAt: new Date('2024-03-04T05:06:07Z') },
      { name: 'random.bin', modifiedAt: new Date('2024-03-04T05:06:07Z') },
    ];
    const contents = [
      Buffer.from('안녕하세요 Storix\n'),
      Buffer.alloc(0),
      Buffer.from('x'.repeat(200_000)),
      randomBytes(64_000),
    ];
    // 여러 chunk로 나눠 증분 CRC와 multi-chunk DEFLATE까지 외부 reader로 고정한다.
    const writer = createZipWriter(
      entries,
      async (entry) => Readable.from(chunked(contents[entries.indexOf(entry)], 4093)),
      {
        compressionLevel,
        maxResultBytes: 2_000_000n,
        signal: new AbortController().signal,
      },
    );
    const zip = await collect(writer.output);
    await writer.settled;
    expect(zip.length).toBe(writer.outputBytes);

    const directory = await mkdtemp(join(tmpdir(), 'storix-zip-'));
    const archivePath = join(directory, 'result.zip');
    try {
      await writeFile(archivePath, zip);
      expect(execFileSync('unzip', ['-t', archivePath], { encoding: 'utf8' })).toContain(
        'No errors detected',
      );
      const result = execFileSync(
        'python3',
        [
          '-c',
          'import hashlib,json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([[i.filename,hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()],ensure_ascii=False))',
          archivePath,
        ],
        { encoding: 'utf8' },
      );
      const inspected = JSON.parse(result) as [string, string][];
      expect(inspected).toEqual(entries.map((entry, index) => [entry.name, createHashHex(contents[index])]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('source를 순차로 열고 모든 ZIP record를 출력 byte 수에 포함한다', async () => {
    const entries = [1, 2, 3].map((index) => ({ name: `file-${index}`, modifiedAt: new Date(0) }));
    let active = 0;
    let maximumActive = 0;
    let opened = 0;
    const writer = createZipWriter(
      entries,
      async () => {
        opened += 1;
        active += 1;
        maximumActive = Math.max(active, maximumActive);
        return Readable.from(
          (async function* () {
            yield Buffer.from('content');
            active -= 1;
          })(),
        );
      },
      { compressionLevel: 1, maxResultBytes: 10_000n, signal: new AbortController().signal },
    );
    const output = await collect(writer.output);
    await writer.settled;

    expect(opened).toBe(3);
    expect(maximumActive).toBe(1);
    expect(writer.outputBytes).toBe(output.length);
    expect(output.readUInt32LE(output.length - 22)).toBe(0x06054b50);
  });

  it('source 오류는 전파되고 이후 entry를 열지 않는다', async () => {
    const sourceError = new Error('source failed');
    let nextOpened = false;
    const entries = ['first', 'second'].map((name) => ({ name, modifiedAt: new Date(0) }));
    const writer = createZipWriter(
      entries,
      async (_entry, index) =>
        index === 0
          ? Readable.from(
              (async function* () {
                yield Buffer.from('partial');
                throw sourceError;
              })(),
            )
          : ((nextOpened = true), Readable.from(['next'])),
      {
        compressionLevel: 1,
        maxResultBytes: 10_000n,
        signal: new AbortController().signal,
      },
    );

    await expect(collect(writer.output)).rejects.toBe(sourceError);
    await expect(writer.settled).rejects.toBe(sourceError);
    expect(nextOpened).toBe(false);
    expect(writer.output.destroyed).toBe(true);
  });

  it('결과 byte 상한을 넘기면 output을 실패시킨다', async () => {
    const writer = createZipWriter(
      [{ name: 'file', modifiedAt: new Date(0) }],
      async () => Readable.from([Buffer.alloc(4096)]),
      { compressionLevel: 0, maxResultBytes: 80n, signal: new AbortController().signal },
    );

    await expect(collect(writer.output)).rejects.toMatchObject({ code: 'VFS_ARCHIVE_TOO_LARGE' });
    await expect(writer.settled).rejects.toMatchObject({ code: 'VFS_ARCHIVE_TOO_LARGE', status: 413 });
    expect(writer.outputBytes).toBeLessThanOrEqual(80);
    expect(writer.output.destroyed).toBe(true);
  });

  it('sink 실패에서 active source와 writer pipeline을 정리한다', async () => {
    const sinkError = new Error('sink failed');
    let sourceDestroyed = false;
    const source = new PassThrough();
    source.on('close', () => (sourceDestroyed = true));
    const writer = createZipWriter([{ name: 'file', modifiedAt: new Date(0) }], async () => source, {
      compressionLevel: 1,
      maxResultBytes: 10_000n,
      signal: new AbortController().signal,
    });
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback(sinkError) });

    await expect(pipeline(writer.output, sink)).rejects.toBe(sinkError);
    await expect(writer.settled).rejects.toBe(sinkError);
    expect(sourceDestroyed).toBe(true);
    expect(writer.output.destroyed).toBe(true);
  });

  it('외부 취소 뒤 다음 entry를 열지 않고 source를 닫는다', async () => {
    const controller = new AbortController();
    let opened = 0;
    let sourceDestroyed = false;
    const source = new PassThrough();
    source.write(Buffer.alloc(512_000, 0x5a));
    source.on('close', () => (sourceDestroyed = true));
    const entries = ['first', 'second'].map((name) => ({ name, modifiedAt: new Date(0) }));
    const writer = createZipWriter(
      entries,
      async () => {
        opened += 1;
        return source;
      },
      { compressionLevel: 1, maxResultBytes: 10_000n, signal: controller.signal },
    );
    const consume = collect(writer.output);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('cancelled'));

    await expect(consume).rejects.toThrow('cancelled');
    await expect(writer.settled).rejects.toThrow('cancelled');
    expect(opened).toBe(1);
    expect(sourceDestroyed).toBe(true);
    expect(writer.output.destroyed).toBe(true);
  });

  it('entry 경계 취소 뒤 다음 source를 열지 않는다', async () => {
    let opened = 0;
    let cancelled = false;
    const entries = ['first', 'second'].map((name) => ({ name, modifiedAt: new Date(0) }));
    const writer = createZipWriter(
      entries,
      async () => {
        opened += 1;
        return Readable.from(['first']);
      },
      { compressionLevel: 0, maxResultBytes: 10_000n, signal: new AbortController().signal },
    );
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (!cancelled && chunk.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08]))) {
          cancelled = true;
          writer.abort(new Error('cancelled between entries'));
          setImmediate(callback);
          return;
        }
        callback();
      },
    });

    await expect(pipeline(writer.output, sink)).rejects.toThrow('cancelled between entries');
    await expect(writer.settled).rejects.toThrow('cancelled between entries');
    expect(cancelled).toBe(true);
    expect(opened).toBe(1);
  });

  it.each(['abort', 'sink'])(
    'source 열기 대기 중 %s는 opener에 최초 오류를 전달한다',
    async (failureKind) => {
      const failure = new Error(`pending ${failureKind}`);
      let notifyOpening!: () => void;
      const opening = new Promise<void>((resolve) => {
        notifyOpening = resolve;
      });
      const writer = createZipWriter(
        [{ name: 'file', modifiedAt: new Date(0) }],
        async (_entry, _index, signal) =>
          new Promise<Readable>((_resolve, reject) => {
            notifyOpening();
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        { compressionLevel: 1, maxResultBytes: 10_000n, signal: new AbortController().signal },
      );
      const sink = new Writable({
        write: (_chunk, _encoding, callback) => {
          callback(failureKind === 'sink' ? failure : undefined);
        },
      });
      const consuming = pipeline(writer.output, sink);
      const consumedFailure = expect(consuming).rejects.toBe(failure);
      const settledFailure = expect(writer.settled).rejects.toBe(failure);
      await opening;
      if (failureKind === 'abort') writer.abort(failure);
      await Promise.all([consumedFailure, settledFailure]);
    },
  );

  it('취소 뒤 반환된 source의 비동기 destroy 완료를 기다린다', async () => {
    const failure = new Error('cancel opening');
    let resolveOpen!: (source: Readable) => void;
    let notifyOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      notifyOpening = resolve;
    });
    const pending = new Promise<Readable>((resolve) => {
      resolveOpen = resolve;
    });
    let finishDestroy!: () => void;
    let notifyDestroy!: () => void;
    const destroying = new Promise<void>((resolve) => {
      notifyDestroy = resolve;
    });
    const source = new Readable({
      read() {},
      destroy(error, callback) {
        finishDestroy = () => callback(error);
        notifyDestroy();
      },
    });
    const writer = createZipWriter(
      [{ name: 'file', modifiedAt: new Date(0) }],
      async () => {
        notifyOpening();
        return pending;
      },
      { compressionLevel: 1, maxResultBytes: 10_000n, signal: new AbortController().signal },
    );
    const consumeFailure = expect(collect(writer.output)).rejects.toBe(failure);
    let settled = false;
    const settledFailure = expect(
      writer.settled.finally(() => {
        settled = true;
      }),
    ).rejects.toBe(failure);
    await opening;
    writer.abort(failure);
    resolveOpen(source);
    await destroying;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finishDestroy();
    await Promise.all([consumeFailure, settledFailure]);
    expect(source.closed).toBe(true);
  });

  it('close 이벤트가 없는 source도 종료 뒤 정착한다', async () => {
    const source = Readable.from(['content'], { emitClose: false });
    const writer = createZipWriter([{ name: 'file', modifiedAt: new Date(0) }], async () => source, {
      compressionLevel: 1,
      maxResultBytes: 10_000n,
      signal: new AbortController().signal,
    });
    await collect(writer.output);
    await writer.settled;
    expect(source.closed).toBe(true);
  });

  it('많은 entry를 처리해도 공유 output의 listener가 누적되지 않는다', async () => {
    const writer = createZipWriter(
      Array.from({ length: 40 }, (_, index) => ({ name: String(index), modifiedAt: new Date(0) })),
      async () => Readable.from(['x']),
      { compressionLevel: 1, maxResultBytes: 10_000n, signal: new AbortController().signal },
    );
    await collect(writer.output);
    await writer.settled;
    expect(writer.output.listenerCount('close')).toBeLessThanOrEqual(2);
  });

  it('ZIP32 entry count 한도를 넘기기 전에 거부한다', async () => {
    const entries = Array.from({ length: 65_535 }, (_, index) => ({
      name: String(index),
      modifiedAt: new Date(0),
    }));
    expect(() =>
      createZipWriter(entries, async () => Readable.from([]), {
        compressionLevel: 1,
        maxResultBytes: 2_147_483_648n,
        signal: new AbortController().signal,
      }),
    ).toThrow(/ZIP32 entry count/i);
  });

  it('ZIP32 size와 offset이 unsigned 32-bit 범위를 넘으면 거부한다', () => {
    expect(toZip32Number(0xffff_ffffn, 'offset')).toBe(0xffff_ffff);
    expect(() => toZip32Number(0x1_0000_0000n, 'offset')).toThrow(/ZIP32 offset exceeded/);
    expect(2_147_483_648).toBeLessThanOrEqual(0xffff_ffff);
  });

  it('느린 sink에서도 source를 한 번에 하나만 연다', async () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      name: String(index),
      modifiedAt: new Date(0),
    }));
    let active = 0;
    let maximumActive = 0;
    const writer = createZipWriter(
      entries,
      async () => {
        active += 1;
        maximumActive = Math.max(active, maximumActive);
        return Readable.from(
          (async function* () {
            for (let index = 0; index < 20; index += 1) yield Buffer.alloc(16_384);
            active -= 1;
          })(),
        );
      },
      { compressionLevel: 0, maxResultBytes: 2_000_000n, signal: new AbortController().signal },
    );
    let total = 0;
    const sink = new Writable({
      highWaterMark: 1,
      write: (chunk: Buffer, _encoding, callback) => {
        total += chunk.length;
        setTimeout(callback, 1);
      },
    });
    await pipeline(writer.output, sink);
    await writer.settled;

    expect(maximumActive).toBe(1);
    expect(writer.outputBytes).toBe(total);
  });

  it('central directory를 쓰는 중 취소하면 EOCD를 쓰지 않고 output을 닫는다', async () => {
    const writer = createZipWriter(
      [{ name: 'file', modifiedAt: new Date(0) }],
      async () => Readable.from(['content']),
      { compressionLevel: 1, maxResultBytes: 10_000n, signal: new AbortController().signal },
    );
    let sawCentralDirectory = false;
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (chunk.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))) {
          sawCentralDirectory = true;
          writer.abort(new Error('cancelled during central directory'));
          setImmediate(() => callback());
          return;
        }
        callback();
      },
    });

    await expect(pipeline(writer.output, sink)).rejects.toThrow('cancelled during central directory');
    await expect(writer.settled).rejects.toThrow('cancelled during central directory');
    expect(sawCentralDirectory).toBe(true);
    expect(writer.outputBytes).toBeLessThanOrEqual(10_000);
  });
});

/** stream을 모두 읽어 byte 배열로 돌려준다. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** 입력을 재현 가능한 비압축성 byte로 만든다. */
function randomBytes(length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

/** 테스트 입력의 SHA-256 hex를 계산한다. */
function createHashHex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
