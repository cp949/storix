// ZIP32 central directory를 range read로 읽고 entry 본문을 STORED·DEFLATE로 푼다.
// zip64·암호화·다른 method·multi-disk는 형식 오류다. local header는 central과 대조하고, bit 3이면 본문 뒤
// data descriptor(12/16 byte)를 검증한다. 본문 stream은 pipeline으로 묶어 downstream destroy가 range GET과 inflate까지
// 전파되게 하고, 상류가 모두 닫힌 뒤에 close를 알린다. 규칙은 docs/design/17-file-extract.md "실행"을 따른다.
import { PassThrough, Transform, pipeline, type Readable } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';
import { waitForClose } from '../common/stream-close.js';
import { ExtractReaderError } from './extract-reader-error.js';
import type { ExtractSourceEntry } from './tar-reader.js';

/** [start, start+length) byte를 Buffer로 돌려준다. length 0은 GET 없이 빈 Buffer다. */
export type RangeReader = (start: bigint, length: number) => Promise<Buffer>;

/** [start, start+length) byte stream을 연다. length 0으로 부르지 않는다. */
export type RangeOpener = (start: bigint, length: number) => Promise<Readable>;

/** readZipEntries 입력이다. */
interface ZipInput {
  /** source 평문 크기다. 모든 range는 이 안에 있어야 한다. */
  readonly size: bigint;

  readonly readRange: RangeReader;

  readonly openRange: RangeOpener;

  readonly signal: AbortSignal;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const EOCD_MIN = 22;
const EOCD_MAX_COMMENT = 65535;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;
const CENTRAL_WINDOW = 65536;
const ZIP64_EXTRA_ID = 0x0001;
const FLAG_ENCRYPTED = 1 << 0;
const FLAG_DESCRIPTOR = 1 << 3;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_MASKED_HEADER = 1 << 13;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const MAX_U32 = 0xffffffff;
const utf8 = new TextDecoder('utf-8', { fatal: true });

interface CentralEntry {
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
  readonly isSymlink: boolean;
}

/**
 * range를 읽고 길이를 확인한다.
 * 범위가 FILE 밖이면 ExtractReaderError, 응답 길이가 다르면 저장소 이상이므로 일반 Error를 던진다.
 */
async function readExact(
  input: ZipInput,
  start: bigint,
  length: number,
  what: string,
  entryName?: string,
): Promise<Buffer> {
  if (start < 0n || start + BigInt(length) > input.size)
    throw new ExtractReaderError(
      entryName === undefined ? 'format' : 'entry',
      `${what} 범위가 FILE 밖`,
      entryName,
    );
  if (length === 0) return Buffer.alloc(0);
  const bytes = await input.readRange(start, length);
  if (bytes.length !== length) throw new Error(`range read 길이 불일치: ${what}`);
  return bytes;
}

/**
 * extra 필드를 TLV로 훑어 zip64 extra가 있는지 돌려준다.
 * TLV 길이가 extra 끝을 넘거나 3 byte 이하 꼬리가 남으면 central directory가 깨진 것이다.
 */
function hasZip64Extra(extra: Buffer): boolean {
  let offset = 0;
  let found = false;
  while (offset < extra.length) {
    if (offset + 4 > extra.length || offset + 4 + extra.readUInt16LE(offset + 2) > extra.length)
      throw new ExtractReaderError('format', 'extra 필드 잘림');
    if (extra.readUInt16LE(offset) === ZIP64_EXTRA_ID) found = true;
    offset += 4 + extra.readUInt16LE(offset + 2);
  }
  return found;
}

/** 끝 최대 65557 byte를 읽어 EOCD를 찾고 central directory 위치를 검증한다. */
async function readEocd(input: ZipInput): Promise<{ entryCount: number; cdSize: number; cdOffset: number }> {
  if (input.size < BigInt(EOCD_MIN)) throw new ExtractReaderError('format', 'ZIP end record 없음');
  const tailLength = Number(
    input.size < BigInt(EOCD_MIN + EOCD_MAX_COMMENT) ? input.size : BigInt(EOCD_MIN + EOCD_MAX_COMMENT),
  );
  const tail = await readExact(input, input.size - BigInt(tailLength), tailLength, 'EOCD');
  for (let offset = tail.length - EOCD_MIN; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    // comment 안에 들어 있는 가짜 signature는 comment 길이가 끝 위치와 맞지 않아 걸러진다.
    if (offset + EOCD_MIN + tail.readUInt16LE(offset + 20) !== tail.length) continue;
    if (tail.readUInt16LE(offset + 4) !== 0 || tail.readUInt16LE(offset + 6) !== 0)
      throw new ExtractReaderError('format', 'multi-disk ZIP');
    const entriesOnDisk = tail.readUInt16LE(offset + 8);
    const entryCount = tail.readUInt16LE(offset + 10);
    const cdSize = tail.readUInt32LE(offset + 12);
    const cdOffset = tail.readUInt32LE(offset + 16);
    if (entryCount === 0xffff || cdSize === MAX_U32 || cdOffset === MAX_U32 || entriesOnDisk === 0xffff)
      throw new ExtractReaderError('format', 'zip64');
    if (entriesOnDisk !== entryCount) throw new ExtractReaderError('format', 'EOCD entry 수 불일치');
    const eocdStart = input.size - BigInt(tailLength) + BigInt(offset);
    if (BigInt(cdOffset) + BigInt(cdSize) !== eocdStart)
      throw new ExtractReaderError('format', 'central directory 범위가 EOCD와 맞지 않음');
    return { entryCount, cdSize, cdOffset };
  }
  throw new ExtractReaderError('format', 'ZIP end record 없음');
}

/**
 * central directory를 순차로 읽는 창이다.
 * record마다 GET하지 않고 64 KiB 창을 한 번에 읽어 나눠 준다. 창보다 큰 record는 그 크기만큼만 읽는다.
 * central directory 전체를 메모리에 올리지 않는다.
 */
class CentralWindow {
  private start = 0n;
  private bytes: Buffer = Buffer.alloc(0);

  constructor(
    private readonly input: ZipInput,
    private readonly cdEnd: bigint,
  ) {}

  /** [offset, offset+length)를 돌려준다. 호출자가 cdEnd 안임을 확인한 범위만 요청한다. */
  async read(offset: bigint, length: number, what: string): Promise<Buffer> {
    const end = this.start + BigInt(this.bytes.length);
    if (offset < this.start || offset + BigInt(length) > end) {
      const remaining = this.cdEnd - offset;
      const want = Number(remaining < BigInt(CENTRAL_WINDOW) ? remaining : BigInt(CENTRAL_WINDOW));
      this.bytes = await readExact(this.input, offset, Math.max(length, want), what);
      this.start = offset;
    }
    const from = Number(offset - this.start);
    return this.bytes.subarray(from, from + length);
  }
}

/** central directory record 하나를 읽는다. 고정 46 byte 뒤 가변 길이를 검증한 뒤 읽는다. */
async function readCentralEntry(
  window: CentralWindow,
  offset: bigint,
  cdEnd: bigint,
): Promise<{ entry: CentralEntry; next: bigint }> {
  if (offset + BigInt(CENTRAL_FIXED) > cdEnd)
    throw new ExtractReaderError('format', 'central directory record 잘림');
  const fixed = await window.read(offset, CENTRAL_FIXED, 'central directory');
  if (fixed.readUInt32LE(0) !== CENTRAL_SIGNATURE)
    throw new ExtractReaderError('format', 'central directory signature 없음');
  const madeBy = fixed.readUInt16LE(4);
  const flags = fixed.readUInt16LE(8);
  const method = fixed.readUInt16LE(10);
  const crc = fixed.readUInt32LE(16);
  const compressedSize = fixed.readUInt32LE(20);
  const size = fixed.readUInt32LE(24);
  const nameLength = fixed.readUInt16LE(28);
  const extraLength = fixed.readUInt16LE(30);
  const commentLength = fixed.readUInt16LE(32);
  const diskStart = fixed.readUInt16LE(34);
  const externalAttributes = fixed.readUInt32LE(38);
  const localHeaderOffset = fixed.readUInt32LE(42);
  const variableStart = offset + BigInt(CENTRAL_FIXED);
  const next = variableStart + BigInt(nameLength + extraLength + commentLength);
  if (next > cdEnd) throw new ExtractReaderError('format', 'central directory 가변 필드 잘림');
  if (diskStart !== 0) throw new ExtractReaderError('format', 'multi-disk ZIP');
  if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADER))
    throw new ExtractReaderError('format', '암호화 ZIP');
  if (method !== METHOD_STORED && method !== METHOD_DEFLATED)
    throw new ExtractReaderError('format', `압축 method ${method}`);
  if (compressedSize === MAX_U32 || size === MAX_U32 || localHeaderOffset === MAX_U32)
    throw new ExtractReaderError('format', 'zip64');
  const variable = await window.read(variableStart, nameLength + extraLength, 'entry 이름과 extra');
  const nameBytes = Buffer.from(variable.subarray(0, nameLength));
  if (hasZip64Extra(variable.subarray(nameLength))) throw new ExtractReaderError('format', 'zip64');
  let name: string;
  try {
    name = utf8.decode(nameBytes);
  } catch {
    throw new ExtractReaderError('entry', 'entry 이름이 UTF-8이 아님', nameBytes.toString('utf8'));
  }
  // 상위 byte가 3(Unix)이고 mode의 파일 종류가 0120000이면 symlink다.
  const isSymlink = madeBy >> 8 === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000;
  return {
    entry: { name, nameBytes, flags, method, crc, compressedSize, size, localHeaderOffset, isSymlink },
    next,
  };
}

/**
 * local header를 central과 대조하고 data 시작 offset을 돌려준다. yield 전에 호출한다.
 * header 고정부와 이름을 GET 한 번으로 읽는다. 이름 길이는 central과 같아야 하므로 central 값을 쓴다.
 */
async function verifyLocalHeader(input: ZipInput, entry: CentralEntry, cdOffset: bigint): Promise<bigint> {
  const start = BigInt(entry.localHeaderOffset);
  const nameLength = entry.nameBytes.length;
  const head = await readExact(input, start, LOCAL_FIXED + nameLength, 'local header', entry.name);
  if (head.readUInt32LE(0) !== LOCAL_SIGNATURE)
    throw new ExtractReaderError('entry', 'local header signature 없음', entry.name);
  const flags = head.readUInt16LE(6);
  const method = head.readUInt16LE(8);
  const localNameLength = head.readUInt16LE(26);
  const extraLength = head.readUInt16LE(28);
  if (flags !== entry.flags || method !== entry.method)
    throw new ExtractReaderError('entry', 'local header flags·method가 central과 다름', entry.name);
  if (localNameLength !== nameLength || !head.subarray(LOCAL_FIXED).equals(entry.nameBytes))
    throw new ExtractReaderError('entry', 'local header 이름이 central과 다름', entry.name);
  const hasDescriptor = (flags & FLAG_DESCRIPTOR) !== 0;
  const localCrc = head.readUInt32LE(14);
  const localCompressed = head.readUInt32LE(18);
  const localSize = head.readUInt32LE(22);
  if (
    !hasDescriptor &&
    (localCrc !== entry.crc || localCompressed !== entry.compressedSize || localSize !== entry.size)
  )
    throw new ExtractReaderError('entry', 'local header CRC·크기가 central과 다름', entry.name);
  if (
    hasDescriptor &&
    ((localCrc !== 0 && localCrc !== entry.crc) ||
      (localCompressed !== 0 && localCompressed !== entry.compressedSize) ||
      (localSize !== 0 && localSize !== entry.size))
  )
    throw new ExtractReaderError('entry', 'local header placeholder가 central과 다름', entry.name);
  const dataStart = start + BigInt(LOCAL_FIXED + nameLength + extraLength);
  // descriptor는 12 byte(signature 없음) 이상 필요하다. 16 byte 여부는 열 때 확인한다.
  const tail = hasDescriptor ? 12n : 0n;
  if (dataStart + BigInt(entry.compressedSize) + tail > cdOffset)
    throw new ExtractReaderError('entry', 'entry 본문이 central directory와 겹침', entry.name);
  return dataStart;
}

/** 본문 뒤 descriptor(12 또는 16 byte)를 읽어 central과 대조한다. signature 유무를 모두 받는다. */
async function verifyDescriptor(
  input: ZipInput,
  entry: CentralEntry,
  dataStart: bigint,
  cdOffset: bigint,
): Promise<void> {
  if ((entry.flags & FLAG_DESCRIPTOR) === 0) return;
  const at = dataStart + BigInt(entry.compressedSize);
  const available = cdOffset - at;
  const bytes = await readExact(
    input,
    at,
    Number(available < 16n ? available : 16n),
    'data descriptor',
    entry.name,
  );
  const matches = (offset: number): boolean =>
    bytes.length >= offset + 12 &&
    bytes.readUInt32LE(offset) === entry.crc &&
    bytes.readUInt32LE(offset + 4) === entry.compressedSize &&
    bytes.readUInt32LE(offset + 8) === entry.size;
  // signature가 없는 descriptor의 CRC가 우연히 signature 값과 같을 수 있어 두 해석을 모두 확인한다.
  const signed = bytes.length >= 16 && bytes.readUInt32LE(0) === DESCRIPTOR_SIGNATURE && matches(4);
  if (!signed && !matches(0))
    throw new ExtractReaderError('entry', 'data descriptor가 central과 다름', entry.name);
}

/** 평문 길이와 CRC-32를 검증하는 Transform. 초과는 즉시, 부족·CRC는 flush에서 실패한다. */
function verifying(entry: CentralEntry): Transform {
  let produced = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      produced += chunk.length;
      if (produced > entry.size) {
        callback(new ExtractReaderError('entry', '평문 길이가 선언보다 큼', entry.name));
        return;
      }
      crc = crc32(chunk, crc);
      callback(null, chunk);
    },
    flush(callback) {
      if (produced !== entry.size)
        callback(new ExtractReaderError('entry', '평문 길이가 선언과 다름', entry.name));
      else if (crc !== entry.crc) callback(new ExtractReaderError('entry', 'CRC-32 불일치', entry.name));
      else callback();
    },
  });
}

/**
 * range 응답이 요청한 압축 크기와 같은지 확인하는 Transform이다.
 * 짧거나 긴 응답은 저장소 이상이므로 형식 오류가 아닌 일반 Error다. inflate가 잘린 입력을 DEFLATE 손상으로
 * 오분류하기 전에 끝에서 실패시킨다.
 */
function rangeGuard(expected: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > expected) callback(new Error('storage range 응답이 요청 길이를 넘음'));
      else callback(null, chunk);
    },
    flush(callback) {
      if (seen !== expected) callback(new Error(`storage range 응답 길이 불일치: ${seen} != ${expected}`));
      else callback();
    },
  });
}

/** zlib 오류를 DEFLATE 손상 entry 오류로 바꾼다. 그 밖의 오류는 그대로 둔다. */
function translateStreamError(error: Error | null, entryName: string): Error | null {
  if (error === null || error instanceof ExtractReaderError) return error;
  if ((error as NodeJS.ErrnoException).code?.startsWith('Z_'))
    return new ExtractReaderError('entry', 'DEFLATE 데이터 손상', entryName);
  return error;
}

/** 본문 stream을 연다. descriptor는 열기 전에 검증한다. */
async function openEntry(
  input: ZipInput,
  entry: CentralEntry,
  dataStart: bigint,
  cdOffset: bigint,
): Promise<Readable> {
  input.signal.throwIfAborted();
  await verifyDescriptor(input, entry, dataStart, cdOffset);
  input.signal.throwIfAborted();
  const verify = verifying(entry);
  if (entry.compressedSize === 0) {
    // 역전 range GET을 만들지 않는다. 빈 입력도 길이·CRC 검증은 거친다.
    verify.end();
    return verify;
  }
  const raw = await input.openRange(dataStart, entry.compressedSize);
  if (input.signal.aborted) {
    raw.destroy();
    await waitForClose(raw);
    throw input.signal.reason;
  }
  const upstream: (Readable | Transform)[] = [raw, rangeGuard(entry.compressedSize)];
  if (entry.method === METHOD_DEFLATED) upstream.push(createInflateRaw());
  upstream.push(verify);
  const out = new PassThrough({
    // 상류가 모두 닫힌 뒤에 close를 알려 소비자가 close를 기다리면 range GET도 정리된 상태가 되게 한다.
    destroy(error, callback) {
      for (const stage of upstream) if (!stage.destroyed) stage.destroy(error ?? undefined);
      void Promise.all(upstream.map(waitForClose)).then(() =>
        callback(translateStreamError(error, entry.name)),
      );
    },
  });
  pipeline([...upstream, out], () => undefined);
  const abort = () => out.destroy(input.signal.reason as Error);
  input.signal.addEventListener('abort', abort, { once: true });
  out.once('close', () => input.signal.removeEventListener('abort', abort));
  return out;
}

/**
 * central directory 순서대로 entry를 돌려준다. 선택 entry 수 한도는 적용하지 않는다.
 * local header 검증은 entry를 돌려주기 전에 끝낸다. DIRECTORY와 제외될 entry도 같다.
 */
export async function* readZipEntries(input: ZipInput): AsyncGenerator<ExtractSourceEntry> {
  const eocd = await readEocd(input);
  const cdOffset = BigInt(eocd.cdOffset);
  const cdEnd = cdOffset + BigInt(eocd.cdSize);
  const window = new CentralWindow(input, cdEnd);
  let cursor = cdOffset;
  for (let index = 0; index < eocd.entryCount; index += 1) {
    input.signal.throwIfAborted();
    const { entry, next } = await readCentralEntry(window, cursor, cdEnd);
    cursor = next;
    if (entry.isSymlink) throw new ExtractReaderError('entry', 'symlink entry', entry.name);
    const dataStart = await verifyLocalHeader(input, entry, cdOffset);
    if (entry.name.endsWith('/')) {
      // 일부 도구는 DIRECTORY를 빈 DEFLATE 스트림(압축 크기 2)으로 저장한다. 평문 크기만 0을 요구한다.
      if (entry.size !== 0)
        throw new ExtractReaderError('entry', 'DIRECTORY entry에 본문이 있음', entry.name);
      yield {
        name: entry.name,
        type: 'DIRECTORY',
        size: 0n,
        compressedSize: 0n,
        open: () => Promise.reject(new Error('DIRECTORY has no body')),
      };
      continue;
    }
    let opened = false;
    yield {
      name: entry.name,
      type: 'FILE',
      size: BigInt(entry.size),
      compressedSize: BigInt(entry.compressedSize),
      open: async () => {
        if (opened) throw new Error('zip entry body opened twice');
        opened = true;
        return openEntry(input, entry, dataStart, cdOffset);
      },
    };
  }
  if (cursor !== cdEnd) throw new ExtractReaderError('format', 'central directory 크기와 record 합이 다름');
}
