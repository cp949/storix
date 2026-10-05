import { VfsRangeNotSatisfiableError } from './vfs.errors.js';

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

// 309자리 이상 십진수는 Number가 Infinity로 바꾼다. 파일 크기는 항상 안전 정수 이하라
// 상한으로 접어도 비교 결과가 같고, end는 파일 끝으로 잘리며 suffix는 전체가 된다.
function parseDecimal(text: string): number {
  return Math.min(Number(text), Number.MAX_SAFE_INTEGER);
}

export function parseRange(header: string, size: number): ByteRange {
  const trimmed = header.trim();

  if (trimmed.includes(',')) {
    throw new VfsRangeNotSatisfiableError(header, size);
  }

  const match = RANGE_PATTERN.exec(trimmed);
  if (!match) {
    throw new VfsRangeNotSatisfiableError(header, size);
  }

  const [, startText, endText] = match;
  if (startText === '' && endText === '') {
    throw new VfsRangeNotSatisfiableError(header, size);
  }

  let start: number;
  let end: number;

  if (startText === '') {
    const suffixLength = parseDecimal(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw new VfsRangeNotSatisfiableError(header, size);
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = parseDecimal(startText);
    end = endText === '' ? size - 1 : parseDecimal(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      throw new VfsRangeNotSatisfiableError(header, size);
    }
  }

  if (size === 0 || start >= size) {
    throw new VfsRangeNotSatisfiableError(header, size);
  }

  return { start, end: Math.min(end, size - 1) };
}
