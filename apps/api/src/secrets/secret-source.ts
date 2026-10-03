/**
 * 비밀값 소스 규약의 공용 선언이다.
 * 규약과 해석 규칙은 docs/design/15-secret-sources.md에 있다.
 */

/** 통신형 비밀값 소스 어댑터의 계약이다. 어댑터 모듈의 기본 export가 이 구조를 따른다. */
export interface SecretSource {
  /** `X_REF`의 scheme이다. `SECRET_SCHEME_PATTERN`을 따른다. */
  readonly scheme: string;

  /** `X_REF` 값 전체(`<scheme>://<참조>`)를 받아 비밀값을 돌려준다. `signal`이 abort되면 작업을 멈춘다. */
  resolve(ref: string, options: { signal: AbortSignal }): Promise<string>;
}

/** `_FILE`·`_REF` 규약을 적용하는 비밀 환경변수 목록이다. 실패 보고 순서도 이 순서를 따른다. */
export const SECRET_ENV_NAMES = [
  'STORIX_API_KEY',
  'STORIX_API_KEY_PREVIOUS',
  'STORIX_ADMIN_API_KEY',
  'STORIX_ADMIN_API_KEY_PREVIOUS',
  'STORIX_ENCRYPTION_MASTER_KEY',
  'STORIX_STORAGE_ACCESS_KEY',
  'STORIX_STORAGE_SECRET_KEY',
  'STORIX_DB_USERNAME',
  'STORIX_DB_PASSWORD',
  'STORIX_SENTRY_DSN',
] as const;

/** scheme 형식이다. 소문자 영문으로 시작한다. */
export const SECRET_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/** 코어가 내장한 파일 소스의 이름이다. `X_REF` scheme으로 쓸 수 없다. */
export const FILE_SOURCE_NAME = 'file';
