import { VfsRangeNotSatisfiableError } from './vfs.errors.js';

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

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
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw new VfsRangeNotSatisfiableError(header, size);
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      throw new VfsRangeNotSatisfiableError(header, size);
    }
  }

  if (size === 0 || start >= size) {
    throw new VfsRangeNotSatisfiableError(header, size);
  }

  return { start, end: Math.min(end, size - 1) };
}
