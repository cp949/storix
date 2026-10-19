// 테스트용 tar 바이트를 직접 만든다. 외부 tar 도구에 의존하지 않는다.
// 헤더 checksum·padding·PAX record 길이를 byte 기준으로 계산하고, 손상 fixture는 정상 fixture의 한 필드만 바꿔 만든다.
import { gzipSync } from 'node:zlib';

/** buildTar가 만들 entry 하나다. */
export interface TarFixtureEntry {
  readonly name: string;

  /** typeflag 한 글자다. 기본값은 일반 FILE `0`이다. */
  readonly type?: '0' | '5' | '1' | '2' | '3' | '4' | '6' | '7' | 'S' | 'x' | 'g' | 'L' | 'K';

  readonly body?: Buffer;

  readonly linkName?: string;

  /** false면 ustar magic을 지운 V7 헤더를 만든다. */
  readonly ustar?: boolean;

  /** 지정하면 POSIX ustar prefix 필드(offset 345)에 쓴다. */
  readonly prefix?: string;
}

/** 8진수 필드. 끝에 NUL을 둔다. */
function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}

/** 헤더 checksum 필드를 현재 내용 기준으로 다시 계산해 쓴다. 필드를 직접 고친 손상 fixture가 쓴다. */
export function fixChecksum(block: Buffer): Buffer {
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(block, 148);
  return block;
}

/** 512 byte 헤더 블록. checksum을 계산해 넣는다. */
export function tarHeader(
  name: string,
  size: number,
  type: string,
  options: { linkName?: string; ustar?: boolean; prefix?: string; rawName?: Buffer } = {},
): Buffer {
  const block = Buffer.alloc(512);
  if (options.rawName) options.rawName.copy(block, 0, 0, 100);
  else block.write(name, 0, 100, 'utf8');
  octal(0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.write(type, 156, 1, 'ascii');
  if (options.linkName) block.write(options.linkName, 157, 100, 'utf8');
  if (options.ustar !== false) {
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
  }
  if (options.prefix) block.write(options.prefix, 345, 155, 'utf8');
  return fixChecksum(block);
}

/** 본문 뒤 512 경계 padding. */
export function pad512(body: Buffer): Buffer {
  const rest = (512 - (body.length % 512)) % 512;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(rest);
}

/** entry 목록으로 끝 블록 두 개를 포함한 tar를 만든다. */
export function buildTar(entries: readonly TarFixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    parts.push(
      tarHeader(entry.name, body.length, entry.type ?? '0', {
        linkName: entry.linkName,
        ustar: entry.ustar,
        prefix: entry.prefix,
      }),
    );
    if (body.length > 0) parts.push(body, pad512(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** PAX 확장 헤더 본문. `len key=value\n`의 len은 레코드 전체 byte 수다. */
export function paxBody(records: Readonly<Record<string, string>>): Buffer {
  return Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const content = Buffer.from(` ${key}=${value}\n`, 'utf8');
      let length = content.length + 1;
      while (String(length).length + content.length !== length)
        length = String(length).length + content.length;
      return Buffer.concat([Buffer.from(String(length), 'ascii'), content]);
    }),
  );
}

/** 확장 헤더(`x`·`g`·`L`) 블록과 본문 padding을 합쳐 돌려준다. 뒤에 실제 entry 헤더를 이어 붙인다. */
export function extensionBlock(type: 'x' | 'g' | 'L', body: Buffer): Buffer {
  return Buffer.concat([
    tarHeader(type === 'L' ? '././@LongLink' : 'ext', body.length, type),
    body,
    pad512(body),
  ]);
}

export function buildTarGz(entries: readonly TarFixtureEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}
