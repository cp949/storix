// tar를 순차로 읽는다. ustar(POSIX prefix)·PAX(x·g)·GNU longname(L)만 지원한다.
// V7(magic 없음)은 형식 오류, link·장치·FIFO·sparse(S·GNU.sparse PAX)는 entry 오류다.
// 첫 next() 이후 reader가 source를 소유한다. 정상 종료·오류·조기 return() 어느 경로로 끝나도 source를 destroy하고
// close를 기다린다. 첫 next() 전에 return()하면 generator 본문이 실행되지 않으므로 source는 호출자 소유로 남는다.
// 규칙은 docs/design/17-file-extract.md "실행"을 따른다.
import { Readable } from 'node:stream';
import { waitForClose } from '../common/stream-close.js';
import { ExtractReaderError } from './extract-reader-error.js';

/** tar·zip reader가 공통으로 돌려주는 entry다. */
export interface ExtractSourceEntry {
  /** 원본 이름이다. 정규화와 검증은 planner가 한다. DIRECTORY는 끝 `/`가 남을 수 있다. */
  readonly name: string;

  readonly type: 'FILE' | 'DIRECTORY';

  /** 선언한 평문 크기다. DIRECTORY는 0이다. */
  readonly size: bigint;

  /** 선언한 압축 크기다. 알 수 없으면 null이다. */
  readonly compressedSize: bigint | null;

  /** FILE 본문 stream을 한 번만 연다. 두 번째 호출은 거부한다. DIRECTORY는 거부한다. */
  open(): Promise<Readable>;
}

const BLOCK = 512;
const MAGIC_END = 263;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 정확한 길이로 잘라 읽는 helper. 취소되면 다음 read에서 reason을 던진다. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);
  private ended = false;
  private readonly aborted: Promise<never>;
  private readonly onAbort: () => void;

  constructor(
    source: Readable,
    private readonly signal: AbortSignal,
  ) {
    this.iterator = (source as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    // fill마다 리스너를 쌓지 않도록 abort 감시는 한 번만 등록한다.
    let rejectAborted!: (reason: unknown) => void;
    this.aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    this.aborted.catch(() => undefined);
    this.onAbort = () => rejectAborted(signal.reason);
    if (signal.aborted) this.onAbort();
    else signal.addEventListener('abort', this.onAbort, { once: true });
  }

  /** abort 리스너를 해제한다. */
  dispose(): void {
    this.signal.removeEventListener('abort', this.onAbort);
  }

  /** 아직 소비하지 않은 byte다. EOF로 헤더가 잘렸을 때 남은 조각을 보는 데 쓴다. */
  remaining(): Buffer {
    return this.buffered;
  }

  private async fill(): Promise<void> {
    this.signal.throwIfAborted();
    // 중단 신호가 먼저 오면 source의 대기 중인 next()를 기다리지 않고 바로 빠져나온다.
    const next = await Promise.race([this.iterator.next(), this.aborted]);
    if (next.done) this.ended = true;
    else
      this.buffered =
        this.buffered.length === 0
          ? (next.value as Buffer)
          : Buffer.concat([this.buffered, next.value as Buffer]);
  }

  /** 정확히 n byte. 부족하면 null(EOF)이고 읽은 조각은 `remaining()`에 남는다. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buffered.length < n && !this.ended) await this.fill();
    if (this.buffered.length < n) return null;
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return out;
  }

  /** 최대 n byte. EOF면 빈 버퍼. */
  async readUpTo(n: number): Promise<Buffer> {
    if (this.buffered.length === 0 && !this.ended) await this.fill();
    const take = Math.min(n, this.buffered.length);
    const out = this.buffered.subarray(0, take);
    this.buffered = this.buffered.subarray(take);
    return out;
  }
}

/** 엄격한 UTF-8 해석이다. 대체 문자로 바꾸지 않고 실패하면 entry 오류를 던진다. */
function decodeUtf8(bytes: Buffer, what: string, entryName?: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ExtractReaderError('entry', `${what}이 UTF-8이 아님`, entryName ?? bytes.toString('utf8'));
  }
}

/** NUL 앞까지의 byte다. 필드 길이 안에 NUL이 없으면 필드 전체다. */
function cBytes(block: Buffer, offset: number, length: number): Buffer {
  const end = block.indexOf(0, offset);
  return block.subarray(offset, end === -1 || end > offset + length ? offset + length : end);
}

/** 8진수 또는 GNU base-256 숫자 필드를 읽는다. 헤더가 손상된 경우 이름을 읽기 전이므로 빈 이름으로 던진다. */
function parseNumeric(block: Buffer, offset: number, length: number): bigint {
  if (block[offset] & 0x80) {
    let value = BigInt(block[offset] & 0x7f);
    for (let i = 1; i < length; i += 1) value = (value << 8n) | BigInt(block[offset + i]);
    return value;
  }
  const text = block
    .toString('latin1', offset, offset + length)
    .replace(/[\0 ]+$/, '')
    .trimStart();
  if (text === '') return 0n;
  if (!/^[0-7]+$/.test(text)) throw new ExtractReaderError('entry', 'tar 숫자 필드가 8진수가 아님', '');
  return BigInt(`0o${text}`);
}

function verifyChecksum(block: Buffer): void {
  const expected = parseNumeric(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (BigInt(sum) !== expected) throw new ExtractReaderError('entry', 'tar 헤더 checksum 불일치', '');
}

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0);

/** PAX 레코드(`len key=value\n`)를 해석한다. len은 레코드 전체의 byte 수다. */
function parsePax(body: Buffer, entryName: string): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const lengthText = space === -1 ? '' : body.toString('latin1', offset, space);
    if (!/^[1-9][0-9]*$/.test(lengthText))
      throw new ExtractReaderError('entry', 'PAX 레코드 길이 오류', entryName);
    const length = Number(lengthText);
    if (offset + length > body.length || body[offset + length - 1] !== 0x0a)
      throw new ExtractReaderError('entry', 'PAX 레코드 길이·개행 오류', entryName);
    const record = decodeUtf8(body.subarray(space + 1, offset + length - 1), 'PAX 레코드', entryName);
    const eq = record.indexOf('=');
    if (eq === -1) throw new ExtractReaderError('entry', 'PAX 레코드에 = 없음', entryName);
    out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

const SPARSE_KEYS = /^(GNU\.sparse\.|SCHILY\.realsize$)/;

const UNSUPPORTED_TYPES: Readonly<Record<string, string>> = {
  '1': 'hard link',
  '2': 'symlink',
  '3': 'char device',
  '4': 'block device',
  '6': 'FIFO',
  '7': 'contiguous file',
  S: 'GNU sparse',
  K: 'GNU longlink',
};

/**
 * size byte를 흘려보내고 끝에서 padding을 소비하는 Readable과 종료 시점을 알리는 promise를 만든다.
 * 본문을 소비하는 쪽이 없어도 오류가 uncaught error로 새지 않도록 error 리스너를 항상 붙인다.
 * 소비자가 끝나기 전에 destroy하면 done도 실패해 generator가 영원히 기다리지 않는다.
 */
function bodyStream(
  reader: ByteReader,
  size: bigint,
  name: string,
): { stream: Readable; done: Promise<void> } {
  let remaining = size;
  let finished = false;
  let settle!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  done.catch(() => undefined);
  const stream = new Readable({
    async read() {
      try {
        if (remaining === 0n) {
          const padding = Number((BigInt(BLOCK) - (size % BigInt(BLOCK))) % BigInt(BLOCK));
          if (padding > 0 && (await reader.read(padding)) === null)
            throw new ExtractReaderError('entry', 'tar 본문 padding 잘림', name);
          finished = true;
          settle();
          this.push(null);
          return;
        }
        const chunk = await reader.readUpTo(Number(remaining > 65536n ? 65536n : remaining));
        if (chunk.length === 0) throw new ExtractReaderError('entry', 'tar 본문 잘림', name);
        remaining -= BigInt(chunk.length);
        this.push(chunk);
      } catch (error) {
        this.destroy(error as Error);
      }
    },
    destroy(error, callback) {
      if (!finished) fail(error ?? new Error('tar entry body destroyed'));
      callback(error);
    },
  });
  stream.on('error', () => undefined);
  return { stream, done };
}

/**
 * tar entry를 순서대로 돌려준다. maxHeaderBytes는 PAX·longname 본문 상한이다.
 *
 * 오류 이름 규칙:
 * - 헤더 자체가 손상돼 이름을 읽지 못하면 entryName은 빈 문자열이다.
 * - 끝 블록 누락·끝 뒤 데이터는 마지막으로 돌려준 entry의 이름을 담는다.
 * - 확장 헤더만 있고 entry가 없으면 확장 헤더가 지정한 이름을 담는다.
 */
export async function* readTarEntries(
  source: Readable,
  options: { readonly maxHeaderBytes: number; readonly signal: AbortSignal },
): AsyncGenerator<ExtractSourceEntry> {
  const reader = new ByteReader(source, options.signal);
  const globals: { path?: string; size?: bigint } = {};
  let pending: { path?: string; size?: bigint } = {};
  let zeroBlocks = 0;
  let headersSeen = 0;
  let lastName = '';
  const hasPending = () => pending.path !== undefined || pending.size !== undefined;
  try {
    for (;;) {
      const block = await reader.read(BLOCK);
      if (block === null) {
        const leftover = reader.remaining();
        if (headersSeen === 0 && zeroBlocks === 0) {
          // 첫 헤더가 잘렸다. ustar magic이 보이면 tar의 잘림, 아니면 tar가 아닌 입력이다.
          if (leftover.length >= MAGIC_END && leftover.toString('latin1', 257, 262) === 'ustar')
            throw new ExtractReaderError('entry', 'tar 헤더 잘림', '');
          throw new ExtractReaderError('format', 'tar 헤더 없음');
        }
        if (leftover.length > 0) throw new ExtractReaderError('entry', 'tar 헤더 잘림', '');
        if (hasPending())
          throw new ExtractReaderError('entry', '확장 헤더 뒤 entry 없음', pending.path ?? lastName);
        throw new ExtractReaderError('entry', 'tar 끝 블록 누락', lastName);
      }
      if (isZeroBlock(block)) {
        if (hasPending())
          throw new ExtractReaderError('entry', '확장 헤더 뒤 entry 없음', pending.path ?? lastName);
        zeroBlocks += 1;
        if (zeroBlocks < 2) continue;
        // 끝 블록 두 개 뒤는 zero padding만 허용한다.
        for (let rest = await reader.readUpTo(65536); rest.length > 0; rest = await reader.readUpTo(65536))
          if (!isZeroBlock(rest))
            throw new ExtractReaderError('entry', 'tar 끝 블록 뒤에 데이터가 있음', lastName);
        return;
      }
      if (zeroBlocks > 0) throw new ExtractReaderError('entry', 'tar 끝 블록 뒤에 데이터가 있음', lastName);
      if (block.toString('latin1', 257, 262) !== 'ustar') {
        if (headersSeen === 0) throw new ExtractReaderError('format', 'ustar magic 없음(V7 tar)');
        throw new ExtractReaderError('entry', 'tar 헤더 magic 불일치', '');
      }
      headersSeen += 1;
      verifyChecksum(block);

      const type = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
      const headerSize = parseNumeric(block, 124, 12);
      // 'ustar\0' + '00'이면 POSIX다. GNU 'ustar  \0'은 345 이후가 prefix가 아니다.
      const posix = block[262] === 0;
      const rawName = decodeUtf8(cBytes(block, 0, 100), 'entry 이름');
      const prefix = posix ? decodeUtf8(cBytes(block, 345, 155), 'entry prefix') : '';
      let name = prefix ? `${prefix}/${rawName}` : rawName;

      if (type === 'x' || type === 'g' || type === 'L') {
        if (headerSize > BigInt(options.maxHeaderBytes))
          throw new ExtractReaderError('entry', '확장 헤더 상한 초과', name);
        const length = Number(headerSize);
        const body = await reader.read(length + ((BLOCK - (length % BLOCK)) % BLOCK));
        if (body === null) throw new ExtractReaderError('entry', '확장 헤더 잘림', name);
        if (type === 'L') {
          pending.path = decodeUtf8(cBytes(body, 0, length), 'GNU longname');
          continue;
        }
        const records = parsePax(body.subarray(0, length), name);
        for (const key of Object.keys(records))
          if (SPARSE_KEYS.test(key))
            // GNU tar는 실제 경로를 `GNU.sparse.name`에 두고 `path`는 PaxHeaders 자리 표시 이름이다.
            throw new ExtractReaderError(
              'entry',
              'GNU sparse PAX entry',
              records['GNU.sparse.name'] ?? records.path ?? pending.path ?? name,
            );
        const target = type === 'g' ? globals : pending;
        if (records.path !== undefined) target.path = records.path;
        if (records.size !== undefined) {
          if (!/^[0-9]+$/.test(records.size)) throw new ExtractReaderError('entry', 'PAX size 오류', name);
          target.size = BigInt(records.size);
        }
        continue;
      }

      name = pending.path ?? globals.path ?? name;
      const size = pending.size ?? globals.size ?? headerSize;
      pending = {};
      lastName = name;

      if (type === '5' || (type === '0' && name.endsWith('/'))) {
        if (size !== 0n) throw new ExtractReaderError('entry', 'DIRECTORY entry에 본문이 있음', name);
        yield {
          name,
          type: 'DIRECTORY',
          size: 0n,
          compressedSize: null,
          open: () => Promise.reject(new Error('DIRECTORY has no body')),
        };
        continue;
      }
      if (type !== '0')
        throw new ExtractReaderError(
          'entry',
          `지원하지 않는 tar entry 종류: ${UNSUPPORTED_TYPES[type] ?? `typeflag ${type}`}`,
          name,
        );

      const { stream, done } = bodyStream(reader, size, name);
      let opened = false;
      yield {
        name,
        type: 'FILE',
        size,
        compressedSize: null,
        open: async () => {
          if (opened) throw new Error('tar entry body opened twice');
          opened = true;
          return stream;
        },
      };
      // 호출자가 열지 않았거나 다 읽지 않은 본문을 버려 다음 헤더 위치를 맞춘다.
      stream.resume();
      await done;
    }
  } finally {
    reader.dispose();
    source.destroy();
    await waitForClose(source);
  }
}
