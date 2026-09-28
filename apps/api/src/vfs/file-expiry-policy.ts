import { VfsInvalidExpiryError } from './vfs.errors.js';

// 파일 만료 입력의 허용 범위. 서비스 생성자에서 한 번 해석해 잘못된 설정은 부팅을 막는다.
export interface FileExpiryBounds {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

export const DEFAULT_FILE_EXPIRY_MIN_SECONDS = 60;
export const DEFAULT_FILE_EXPIRY_MAX_SECONDS = 2592000;
// resumable 세션의 file_expires_in_seconds는 PostgreSQL INTEGER다.
export const MAX_FILE_EXPIRY_SECONDS = 2_147_483_647;
export const DEFAULT_FILE_EXPIRY_BOUNDS: FileExpiryBounds = {
  minSeconds: DEFAULT_FILE_EXPIRY_MIN_SECONDS,
  maxSeconds: DEFAULT_FILE_EXPIRY_MAX_SECONDS,
};

function parseBound(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function resolveFileExpiryBounds(min: string | undefined, max: string | undefined): FileExpiryBounds {
  const minSeconds = parseBound(min, DEFAULT_FILE_EXPIRY_MIN_SECONDS, 'STORIX_VFS_EXPIRY_MIN_SECONDS');
  const maxSeconds = parseBound(max, DEFAULT_FILE_EXPIRY_MAX_SECONDS, 'STORIX_VFS_EXPIRY_MAX_SECONDS');
  if (maxSeconds > MAX_FILE_EXPIRY_SECONDS) {
    throw new Error('Invalid STORIX_VFS_EXPIRY_MAX_SECONDS: exceeds PostgreSQL INTEGER limit');
  }
  if (minSeconds > maxSeconds) {
    throw new Error('STORIX_VFS_EXPIRY_MIN_SECONDS exceeds STORIX_VFS_EXPIRY_MAX_SECONDS');
  }
  return { minSeconds, maxSeconds };
}

// 설정 범위와 분리해 JSON 만료 입력의 형태·DB 저장 가능 범위만 확인한다.
export function parseExpirySeconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_FILE_EXPIRY_SECONDS
  ) {
    throw new VfsInvalidExpiryError();
  }
  return value;
}

// JSON 입력(resumable)과 헤더 파싱 결과가 공유하는 현재 정책 범위 검사.
export function assertExpirySeconds(value: unknown, bounds: FileExpiryBounds): number {
  const seconds = parseExpirySeconds(value);
  if (seconds < bounds.minSeconds || seconds > bounds.maxSeconds) throw new VfsInvalidExpiryError();
  return seconds;
}

// X-Expires-In은 부호·공백·소수·지수·선행 0 없는 10진 정수만 받는다.
export function parseExpiresInHeader(raw: string, bounds: FileExpiryBounds): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new VfsInvalidExpiryError();
  return assertExpirySeconds(Number(raw), bounds);
}
