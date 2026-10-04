/** TCP 포트의 최댓값이다. */
export const MAX_TCP_PORT = 65535;

/** `setTimeout`이 받는 32비트 부호 있는 정수의 최댓값(ms)이다. 넘으면 타이머가 1ms 뒤에 발화한다. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * 양의 정수 환경변수를 읽는다.
 * 값이 없거나 빈 문자열이면 `fallback`을 돌려주고 `fallback`은 검사하지 않는다.
 *
 * 거부 조건:
 * - 10진수 숫자만으로 된 표기가 아니다(`1e3`, `0x10`, ` 5 `, `+5`, `5.0`, 앞자리 0).
 * - 안전 정수 범위를 넘는다.
 * - `max`를 주었고 값이 `max`를 넘는다.
 *
 * 거부하면 `잘못된 정수 환경변수 값` 메시지의 일반 `Error`를 던진다.
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

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

export function parseOptionalString(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
