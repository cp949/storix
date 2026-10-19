/**
 * 계약 fixture용 ZIP32 바이트 생성기. API 소스를 import하지 않고 local header·central directory·EOCD를 직접 쓴다.
 * 손상 사례를 만들 수 있도록 CRC와 local header 이름을 덮어쓸 수 있다.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** ZIP entry 하나다. 이름이 `/`로 끝나면 DIRECTORY다. */
export interface ZipEntry {
  readonly name: string;
  readonly body?: Buffer | string;

  /** true면 DEFLATE, 아니면 STORED다. */
  readonly deflate?: boolean;

  /** central과 local의 CRC를 덮어써 CRC 불일치를 만든다. */
  readonly crc?: number;

  /** local header 이름만 바꾼다. central 이름과 byte 길이가 같아야 한다. */
  readonly localName?: string;

  /** Unix 파일 mode. 지정하면 Unix 호스트 entry로 쓴다. symlink는 `0o120777`이다. */
  readonly unixMode?: number;
}

/** entry 목록으로 ZIP32를 만든다. */
export function zipBytes(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const method = entry.deflate ? 8 : 0;
    const data = entry.deflate ? deflateRawSync(body) : body;
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const crc = entry.crc ?? crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(localName.length, 26);
    const localBytes = Buffer.concat([local, localName, data]);
    locals.push(localBytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.unixMode === undefined ? 0 : (entry.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localBytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
