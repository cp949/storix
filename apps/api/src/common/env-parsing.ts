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

/** `STORIX_PORT`가 없을 때 쓰는 listen 포트다. */
export const DEFAULT_LISTEN_PORT = 3000;

/**
 * listen 포트 환경변수를 읽는다.
 * 값이 없거나 빈 문자열이면 `DEFAULT_LISTEN_PORT`다.
 *
 * `0`은 OS가 빈 포트를 배정하는 값이라 허용한다(통합 테스트가 쓴다). 그 밖에는 1~65535의 10진 정수 표기만 받는다.
 * `listen()`에 문자열을 그대로 넘기면 `3000abc`는 UNIX socket 경로로, `0x1F90`은 8080으로 해석되므로
 * 문자열을 넘기지 않고 이 함수의 숫자 결과만 넘긴다.
 */
export function parseListenPort(value: string | undefined): number {
  if (value === '0') {
    return 0;
  }

  return parsePositiveInt(value, DEFAULT_LISTEN_PORT, MAX_TCP_PORT);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`필수 환경변수가 설정되지 않음: ${name}`);
  }

  return value;
}

/**
 * 불리언 환경변수를 읽는다. 값이 없거나 빈 문자열이면 `fallback`이다.
 *
 * `true`·`false`만 받고 대소문자는 구분하지 않는다. `1`, `yes`, 공백이 붙은 값 등 그 밖의 값은
 * `name`을 담은 `잘못된 불리언 환경변수 값` 메시지의 일반 `Error`로 거부한다.
 * true가 아닌 값을 조용히 false로 처리하면 `STORIX_STORAGE_USE_SSL=1`이 평문 연결이 되는 등
 * 운영자 의도와 반대로 동작한다.
 */
export function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`잘못된 불리언 환경변수 값: ${name}=${value} (true 또는 false)`);
}

export function parseOptionalString(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
