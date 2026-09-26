import { parsePositiveInt } from './env-parsing.js';

// STORIX_MAX_FILE_SIZE_BYTES 미설정 시 단일 파일 상한(5 GiB)
export const DEFAULT_MAX_FILE_SIZE_BYTES = 5368709120;

export function resolveEffectiveLimit(namespaceValue: number | null, globalValue: number): number {
  // 전역값은 항상 hard ceiling이므로 비정상 값(NaN 등)도 안전한 쪽으로 처리한다
  if (namespaceValue === null || !Number.isFinite(namespaceValue)) {
    return globalValue;
  }
  return Math.min(namespaceValue, globalValue);
}

export function resolveGlobalMaxFileSizeBytes(value: string | undefined): number {
  return parsePositiveInt(value, DEFAULT_MAX_FILE_SIZE_BYTES);
}

// 업로드 강제와 namespace 응답이 같은 규칙으로 적용 파일 상한을 계산하게 한다
export function resolveMaxFileSizeBytes(namespaceValue: string | null | undefined, globalValue: number): number {
  return resolveEffectiveLimit(namespaceValue == null ? null : Number(namespaceValue), globalValue);
}
