import { parsePositiveInt } from './env-parsing.js';

/** S3 multipart part 크기와 최대 part 수에서 계산한 단일 object 구조상한. */
export const S3_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const S3_MULTIPART_MAX_PARTS = 10_000;
export const MAX_OBJECT_BYTES = S3_MULTIPART_PART_SIZE_BYTES * S3_MULTIPART_MAX_PARTS;

/** 파일 크기 제한의 기본값. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 5368709120;
export const DEFAULT_MAX_FILES_PER_FOLDER = 10_000;
export const DEFAULT_MAX_LIVE_NODES = 1_000_000;

export interface CountLimits {
  readonly defaultValue: number;
  readonly ceilingValue: number;
}

export function resolveCountLimits(
  defaultEnv: string | undefined,
  ceilingEnv: string | undefined,
  builtInDefault = DEFAULT_MAX_FILES_PER_FOLDER,
): CountLimits {
  const parse = (value: string | undefined): number | undefined => {
    if (value === undefined || value.trim() === '') return undefined;
    if (!/^[1-9][0-9]*$/.test(value.trim())) throw new Error('count limit must be a positive integer');
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('count limit is outside the safe integer range');
    return number;
  };
  const ceiling = parse(ceilingEnv);
  const defaultValue = parse(defaultEnv) ?? ceiling ?? builtInDefault;
  const ceilingValue = ceiling ?? defaultValue;
  if (defaultValue > ceilingValue) throw new Error('count default exceeds ceiling');
  return { defaultValue, ceilingValue };
}

/** 파일 크기의 기본값과 ceiling. */
export interface FileSizeLimits {
  readonly defaultBytes: number;
  readonly ceilingBytes: number;
}

/** namespace override를 기본값 또는 ceiling에 맞춰 계산한다. */
export function resolveEffectiveLimit(
  namespaceValue: number | null,
  ceilingValue: number,
  defaultValue = ceilingValue,
): number {
  if (namespaceValue === null || !Number.isFinite(namespaceValue)) {
    return defaultValue;
  }
  return Math.min(namespaceValue, ceilingValue);
}

/** DEFAULT·MAX 환경변수에서 파일 크기 기본값과 ceiling을 해석한다. */
export function resolveFileSizeLimits(
  defaultValue: string | undefined,
  ceilingValue: string | undefined,
): FileSizeLimits {
  const maximum = parseOptional(defaultValue);
  const ceiling = parseOptional(ceilingValue);
  const resolvedDefault = maximum ?? ceiling ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const resolvedCeiling = ceiling ?? resolvedDefault;
  if (resolvedDefault > resolvedCeiling) throw new Error('file size default exceeds ceiling');
  if (resolvedCeiling > MAX_OBJECT_BYTES) throw new Error('file size ceiling exceeds maximum object size');
  return { defaultBytes: resolvedDefault, ceilingBytes: resolvedCeiling };
}

/** 이전 단일 전역 설정 호환용으로 파일 크기 ceiling을 돌려준다. */
export function resolveGlobalMaxFileSizeBytes(value: string | undefined): number {
  return resolveFileSizeLimits(undefined, value).ceilingBytes;
}

// 업로드 강제와 namespace 응답이 같은 규칙으로 적용 파일 상한을 계산하게 한다
export function resolveMaxFileSizeBytes(
  namespaceValue: string | null | undefined,
  globalValue: number,
  defaultValue = globalValue,
): number {
  return resolveEffectiveLimit(
    namespaceValue == null ? null : Number(namespaceValue),
    globalValue,
    defaultValue,
  );
}

function parseOptional(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  return parsePositiveInt(value, DEFAULT_MAX_FILE_SIZE_BYTES);
}
