/** TCP 포트의 최댓값이다. */
export const MAX_TCP_PORT = 65535;

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * 양의 정수 환경변수를 읽는다. 값이 없거나 빈 문자열이면 `fallback`이다.
 * 10진수 숫자만으로 된 표기(`1e3`, `0x10`, 공백, `+5`, `5.0`, 앞자리 0 제외), 안전 정수 범위, `max` 이하만 받는다.
 */
export function parsePositiveInt(value: string | undefined, fallback: number, max?: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`잘못된 정수 환경변수 값: ${value}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`잘못된 정수 환경변수 값: ${value} (최대 ${max})`);
  }
  return parsed;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`필수 환경변수가 설정되지 않음: ${name}`);
  }
  return value;
}

export function parseOptionalString(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
