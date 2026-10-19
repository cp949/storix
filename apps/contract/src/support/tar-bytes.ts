/**
 * 계약 fixture용 tar 바이트 생성기. API 소스를 import하지 않고 ustar 형식을 직접 쓴다.
 * 이름은 100 byte 이하만 다룬다. 긴 이름·PAX 헤더는 API 단위 테스트가 검증한다.
 */
import { gzipSync } from 'node:zlib';

/** tar entry 하나다. `type` 기본값은 일반 FILE이다. */
export interface TarEntry {
  readonly name: string;
  readonly body?: Buffer | string;
  readonly type?: 'file' | 'dir' | 'symlink';
  readonly linkName?: string;
}

const TYPEFLAG = { file: '0', dir: '5', symlink: '2' } as const;

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, '0')}\0`, 'ascii');
}

/** 512 byte ustar 헤더를 만든다. checksum은 필드를 공백으로 채운 합이다. */
function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, 'utf8');
  octal(entry.type === 'dir' ? 0o755 : 0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(TYPEFLAG[entry.type ?? 'file'], 156, 1, 'ascii');
  if (entry.linkName !== undefined) block.write(entry.linkName, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** entry 목록으로 끝 블록 두 개를 포함한 tar를 만든다. */
export function tarBytes(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    parts.push(header(entry, body.length));
    if (body.length > 0) parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** tar를 gzip으로 감싼다. */
export function tarGzBytes(entries: readonly TarEntry[]): Buffer {
  return gzipSync(tarBytes(entries));
}
