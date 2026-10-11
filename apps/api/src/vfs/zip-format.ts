// ZIP32 record(local header·data descriptor·central directory·EOCD)의 byte를 만드는 순수 인코더다.
// 필드 위치·폭은 PKWARE APPNOTE 6.3.x를 따른다. stream 수명은 zip-writer.ts가 맡는다.

// APPNOTE 4.4.5 compression method.
export const ZIP_METHOD_STORED = 0;
export const ZIP_METHOD_DEFLATED = 8;

// APPNOTE 4.4.4 general purpose bit flag. bit 3은 크기·CRC를 data descriptor에 뒤따라 쓴다는 뜻이고,
// bit 11은 이름이 UTF-8이라는 뜻이다. 둘 다 stream 작성에 필요하다.
export const ZIP_FLAG_DATA_DESCRIPTOR = 1 << 3;
export const ZIP_FLAG_UTF8 = 1 << 11;

// APPNOTE 4.4.3 version needed to extract. 2.0은 DEFLATE와 data descriptor를 읽는 최소 버전이다.
export const ZIP_VERSION_NEEDED = 20;

/** DOS 날짜와 시각 필드다. */
export interface DosDateTime {
  /** 2초 단위 시각 필드다. */
  time: number;

  /** 1980년 기준 날짜 필드다. */
  date: number;
}

/** central directory entry를 만드는 데 필요한 값이다. */
export interface CentralDirectoryEntry {
  /** UTF-8로 인코딩한 상대 파일 이름이다. */
  name: Buffer;

  /** 파일 수정 시각이다. */
  modifiedAt: Date;

  /** ZIP 저장 방식이다. */
  method: number;

  /** 원본 바이트의 CRC-32다. */
  crc32: number;

  /** 압축된 byte 수다. */
  compressedSize: number;

  /** 원본 byte 수다. */
  uncompressedSize: number;

  /** local header의 출력 시작 위치다. */
  localHeaderOffset: number;
}

/** UTC 시각을 ZIP DOS 날짜와 시각으로 변환한다. */
export function toDosDateTime(value: Date): DosDateTime {
  const timestamp = Number.isFinite(value.getTime()) ? value.getTime() : 0;
  const date = new Date(
    Math.min(Math.max(timestamp, Date.UTC(1980, 0, 1)), Date.UTC(2107, 11, 31, 23, 59, 58)),
  );
  const year = date.getUTCFullYear();
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: dosDate };
}

/** data descriptor 방식의 local file header를 만든다. */
export function encodeLocalFileHeader(name: Buffer, modifiedAt: Date, method: number): Buffer {
  const dateTime = toDosDateTime(modifiedAt);
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
  header.writeUInt16LE(ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(dateTime.time, 10);
  header.writeUInt16LE(dateTime.date, 12);
  header.writeUInt16LE(name.length, 26);
  name.copy(header, 30);
  return header;
}

/** signature가 있는 ZIP data descriptor를 만든다. */
export function encodeDataDescriptor(
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32 >>> 0, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  return descriptor;
}

/** 파일 하나의 central directory record를 만든다. */
export function encodeCentralDirectoryEntry(entry: CentralDirectoryEntry): Buffer {
  const dateTime = toDosDateTime(entry.modifiedAt);
  const record = Buffer.alloc(46 + entry.name.length);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
  record.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
  record.writeUInt16LE(ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8, 8);
  record.writeUInt16LE(entry.method, 10);
  record.writeUInt16LE(dateTime.time, 12);
  record.writeUInt16LE(dateTime.date, 14);
  record.writeUInt32LE(entry.crc32 >>> 0, 16);
  record.writeUInt32LE(entry.compressedSize, 20);
  record.writeUInt32LE(entry.uncompressedSize, 24);
  record.writeUInt16LE(entry.name.length, 28);
  record.writeUInt32LE(entry.localHeaderOffset, 42);
  entry.name.copy(record, 46);
  return record;
}

/** ZIP archive의 EOCD record를 만든다. */
export function encodeEndOfCentralDirectory(value: {
  /** archive의 entry 수다. */
  entryCount: number;

  /** central directory byte 수다. */
  centralDirectorySize: number;

  /** central directory 시작 위치다. */
  centralDirectoryOffset: number;
}): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(value.entryCount, 8);
  record.writeUInt16LE(value.entryCount, 10);
  record.writeUInt32LE(value.centralDirectorySize, 12);
  record.writeUInt32LE(value.centralDirectoryOffset, 16);
  return record;
}
