export class VfsInvalidRangeError extends Error {
  readonly code = 'VFS_INVALID_RANGE';

  constructor(start: number, end: number) {
    super(`유효하지 않은 range: start=${start}, end=${end}`);
  }
}

export class VfsFileTooLargeError extends Error {
  readonly code = 'VFS_FILE_TOO_LARGE';
  readonly status = 413;

  constructor(readonly maxBytes: number) {
    super(`파일 크기가 상한(${maxBytes} bytes)을 초과함`);
  }
}
