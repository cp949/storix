// source 앞 byte의 magic으로 형식 후보를 판정한다. 확장자와 MIME은 쓰지 않는다.

/** 1차 범위의 압축 형식이다. */
export type ExtractFormat = 'zip' | 'tar' | 'tar.gz';

const BLOCK = 512;
const USTAR_END = 263;

/**
 * 앞 byte를 보고 형식 후보를 돌려준다. 모르면 null이다.
 *
 * 판별 규칙:
 * - `PK\x03\x04`(local header) 또는 `PK\x05\x06`(빈 ZIP)는 zip이다.
 * - `1f 8b`는 tar.gz 후보다. 내부가 tar인지는 reader가 확인한다.
 * - offset 257의 `ustar`는 tar다. 이 위치까지 읽으려면 head가 263 byte 이상이어야 한다.
 * - 첫 512 byte가 전부 zero이면 빈 tar 후보다. 끝 블록 두 개는 reader가 확인한다.
 */
export function detectExtractFormat(head: Buffer): ExtractFormat | null {
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
    if ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06)) return 'zip';
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
  if (head.length >= USTAR_END && head.toString('latin1', 257, 262) === 'ustar') return 'tar';
  if (head.length >= BLOCK && head.subarray(0, BLOCK).every((byte) => byte === 0)) return 'tar';
  return null;
}
