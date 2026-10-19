// 테스트용 ZIP 바이트를 만든다. handZip은 필드를 직접 제어하는 최소 ZIP, buildZip은 Storix writer 출력이다.
// bufferRanges는 Buffer 위에서 동작하는 range reader/opener라서 저장소 없이 reader를 검증한다.
import { Readable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';
import { createZipWriter } from '../../src/vfs/zip-writer.js';

/** handZip이 만들 entry 하나다. 지정하지 않은 필드는 정상값으로 계산한다. */
export interface HandZipEntry {
  readonly name: string;

  readonly body?: Buffer;

  readonly method?: 0 | 8 | number;

  readonly flags?: number;

  readonly madeBy?: number;

  readonly external?: number;

  /** local·central·descriptor에 모두 쓰는 CRC다. */
  readonly crc?: number;

  /** local·central·descriptor에 모두 쓰는 압축 크기다. */
  readonly compressedSize?: number;

  /** local·central·descriptor에 모두 쓰는 평문 크기다. */
  readonly uncompressedSize?: number;

  /** bit 3 descriptor를 붙인다. 'signed'면 signature 포함 16 byte, 'unsigned'면 12 byte. */
  readonly descriptor?: 'signed' | 'unsigned';

  /** descriptor에만 다른 값을 써서 central과 어긋나게 한다. */
  readonly descriptorOverride?: { crc?: number; compressedSize?: number; uncompressedSize?: number };

  /** local header의 CRC·크기 필드에 쓸 값이다. bit 3이 없을 때만 central과 다르게 만들 수 있다. */
  readonly localOverride?: { crc?: number; compressedSize?: number; uncompressedSize?: number };

  readonly extra?: Buffer;
}

export interface HandZipOptions {
  readonly comment?: Buffer;

  /** EOCD와 central의 disk 번호에 쓴다. */
  readonly diskNumber?: number;

  /** EOCD의 "이 disk의 entry 수" 필드에만 쓴다. */
  readonly cdEntriesOverride?: number;
}

/** entry 목록으로 ZIP32를 만든다. local·central·EOCD를 직접 쓴다. */
export function handZip(entries: readonly HandZipEntry[], options: HandZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const data = method === 8 ? deflateRawSync(body) : body;
    const name = Buffer.from(entry.name, 'utf8');
    const extra = entry.extra ?? Buffer.alloc(0);
    const crc = entry.crc ?? crc32(body);
    const compressedSize = entry.compressedSize ?? data.length;
    const uncompressedSize = entry.uncompressedSize ?? body.length;
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 1 << 3 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    const localCrc = entry.localOverride?.crc ?? (entry.descriptor ? 0 : crc);
    const localCompressed = entry.localOverride?.compressedSize ?? (entry.descriptor ? 0 : compressedSize);
    const localSize = entry.localOverride?.uncompressedSize ?? (entry.descriptor ? 0 : uncompressedSize);
    local.writeUInt32LE(localCrc >>> 0, 14);
    local.writeUInt32LE(localCompressed, 18);
    local.writeUInt32LE(localSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const parts = [local, name, extra, data];
    if (entry.descriptor) {
      const override = entry.descriptorOverride ?? {};
      const descriptor = Buffer.alloc(entry.descriptor === 'signed' ? 16 : 12);
      let at = 0;
      if (entry.descriptor === 'signed') {
        descriptor.writeUInt32LE(0x08074b50, 0);
        at = 4;
      }
      descriptor.writeUInt32LE((override.crc ?? crc) >>> 0, at);
      descriptor.writeUInt32LE(override.compressedSize ?? compressedSize, at + 4);
      descriptor.writeUInt32LE(override.uncompressedSize ?? uncompressedSize, at + 8);
      parts.push(descriptor);
    }
    const localBytes = Buffer.concat(parts);
    locals.push(localBytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(options.diskNumber ?? 0, 34);
    central.writeUInt32LE(entry.external ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name, extra]));
    offset += localBytes.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = options.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(options.diskNumber ?? 0, 6);
  eocd.writeUInt16LE(options.cdEntriesOverride ?? entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

/** handZip 결과에서 central directory 시작 offset을 읽는다. 손상 fixture가 record 위치를 찾는 데 쓴다. */
export function centralDirectoryOffset(zip: Buffer): number {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return zip.readUInt32LE(eocd + 16);
}

/** Storix writer로 만든 ZIP. bit 3 descriptor·DEFLATE·UTF-8 flag가 붙는다. */
export async function buildZip(
  files: readonly { name: string; body: Buffer }[],
  compressionLevel = 1,
): Promise<Buffer> {
  const zip = createZipWriter(
    files.map((file) => ({ name: file.name, modifiedAt: new Date(0) })),
    async (_entry, index) => Readable.from([files[index].body]),
    { compressionLevel, maxResultBytes: 1n << 31n, signal: new AbortController().signal },
  );
  const chunks: Buffer[] = [];
  for await (const chunk of zip.output) chunks.push(chunk as Buffer);
  await zip.settled;
  return Buffer.concat(chunks);
}

/** Buffer 위에서 동작하는 range reader/opener. chunkSize로 openRange 응답을 쪼개고 호출 기록을 남긴다. */
export function bufferRanges(zip: Buffer, chunkSize = 64) {
  const calls = { read: [] as [bigint, number][], open: [] as [bigint, number][] };
  const slice = (start: bigint, length: number) => {
    if (start < 0n || length < 0 || start + BigInt(length) > BigInt(zip.length))
      throw new Error('range out of bounds');
    return zip.subarray(Number(start), Number(start) + length);
  };
  return {
    calls,
    size: BigInt(zip.length),
    readRange: async (start: bigint, length: number) => {
      calls.read.push([start, length]);
      return Buffer.from(slice(start, length));
    },
    openRange: async (start: bigint, length: number) => {
      calls.open.push([start, length]);
      const bytes = slice(start, length);
      const chunks: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
      return Readable.from(chunks);
    },
  };
}
