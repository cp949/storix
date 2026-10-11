// ZIP record 인코더의 바이트 계약을 고정한다.
import {
  ZIP_FLAG_DATA_DESCRIPTOR,
  ZIP_FLAG_UTF8,
  ZIP_METHOD_DEFLATED,
  ZIP_METHOD_STORED,
  ZIP_VERSION_NEEDED,
  encodeCentralDirectoryEntry,
  encodeDataDescriptor,
  encodeEndOfCentralDirectory,
  encodeLocalFileHeader,
  toDosDateTime,
} from '../../src/vfs/zip-format.js';

// 고정 필드와 DOS 시각 경계를 byte 단위로 확인한다.
describe('ZIP 형식 인코더', () => {
  it('local header와 data descriptor의 고정 필드를 인코딩한다', () => {
    const name = Buffer.from('한글 a.txt');
    const header = encodeLocalFileHeader(name, new Date('2024-03-04T05:06:07.000Z'), ZIP_METHOD_DEFLATED);

    expect(header.readUInt32LE(0)).toBe(0x04034b50);
    expect(header.readUInt16LE(4)).toBe(ZIP_VERSION_NEEDED);
    expect(header.readUInt16LE(6)).toBe(ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8);
    expect(header.readUInt16LE(8)).toBe(ZIP_METHOD_DEFLATED);
    expect(header.readUInt16LE(26)).toBe(name.length);
    expect(header.subarray(30)).toEqual(name);
    expect(encodeDataDescriptor(0x12345678, 9, 11)).toEqual(
      Buffer.from([0x50, 0x4b, 0x07, 0x08, 0x78, 0x56, 0x34, 0x12, 9, 0, 0, 0, 11, 0, 0, 0]),
    );
  });

  it('central directory와 EOCD에 CRC·크기·offset·entry 수를 기록한다', () => {
    const entry = encodeCentralDirectoryEntry({
      name: Buffer.from('a.txt'),
      modifiedAt: new Date('2024-03-04T05:06:07.000Z'),
      method: ZIP_METHOD_STORED,
      crc32: 0x12345678,
      compressedSize: 11,
      uncompressedSize: 9,
      localHeaderOffset: 7,
    });
    const eocd = encodeEndOfCentralDirectory({
      entryCount: 1,
      centralDirectorySize: entry.length,
      centralDirectoryOffset: 23,
    });

    expect(entry.readUInt32LE(0)).toBe(0x02014b50);
    expect(entry.readUInt16LE(4)).toBe(ZIP_VERSION_NEEDED);
    expect(entry.readUInt16LE(6)).toBe(ZIP_VERSION_NEEDED);
    expect(entry.readUInt16LE(8)).toBe(ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8);
    expect(entry.readUInt32LE(16)).toBe(0x12345678);
    expect(entry.readUInt32LE(20)).toBe(11);
    expect(entry.readUInt32LE(24)).toBe(9);
    expect(entry.readUInt32LE(42)).toBe(7);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(8)).toBe(1);
    expect(eocd.readUInt16LE(10)).toBe(1);
    expect(eocd.readUInt32LE(12)).toBe(entry.length);
    expect(eocd.readUInt32LE(16)).toBe(23);
  });

  it('DOS 시각을 2초 단위와 ZIP 지원 범위로 변환한다', () => {
    expect(toDosDateTime(new Date('2024-03-04T05:06:07.000Z'))).toEqual({
      time: (5 << 11) | (6 << 5) | 3,
      date: (44 << 9) | (3 << 5) | 4,
    });
    expect(toDosDateTime(new Date('1970-01-01T00:00:00.000Z'))).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(toDosDateTime(new Date('2200-01-01T00:00:00.000Z'))).toEqual({
      time: (23 << 11) | (59 << 5) | 29,
      date: (127 << 9) | (12 << 5) | 31,
    });
  });
});
