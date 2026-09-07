import { parseBoolean, parseOptionalString, parsePositiveInt, requireEnv } from './env-parsing.js';

describe('parsePositiveInt', () => {
  it('값이 없으면 fallback을 반환한다', () => {
    expect(parsePositiveInt(undefined, 5432)).toBe(5432);
  });

  it('빈 문자열이면 fallback을 반환한다', () => {
    expect(parsePositiveInt('', 5432)).toBe(5432);
  });

  it('유효한 숫자 문자열을 정수로 변환한다', () => {
    expect(parsePositiveInt('9000', 5432)).toBe(9000);
  });

  it('0 이하의 값은 거부한다', () => {
    expect(() => parsePositiveInt('0', 5432)).toThrow();
  });

  it('숫자가 아닌 값은 거부한다', () => {
    expect(() => parsePositiveInt('abc', 5432)).toThrow();
  });
});

describe('parseBoolean', () => {
  it('값이 없으면 fallback을 반환한다', () => {
    expect(parseBoolean(undefined, false)).toBe(false);
  });

  it('빈 문자열이면 fallback을 반환한다', () => {
    expect(parseBoolean('', true)).toBe(true);
  });

  it('대소문자 구분 없이 true를 인식한다', () => {
    expect(parseBoolean('TRUE', false)).toBe(true);
    expect(parseBoolean('True', false)).toBe(true);
  });

  it('true가 아닌 값은 false로 처리한다', () => {
    expect(parseBoolean('false', true)).toBe(false);
    expect(parseBoolean('1', true)).toBe(false);
  });
});

describe('parseOptionalString', () => {
  it('값이 없으면 undefined를 반환한다', () => {
    expect(parseOptionalString(undefined)).toBeUndefined();
  });

  it('빈 문자열이면 undefined를 반환한다', () => {
    expect(parseOptionalString('')).toBeUndefined();
  });

  it('값이 있으면 그대로 반환한다', () => {
    expect(parseOptionalString('us-east-1')).toBe('us-east-1');
  });
});

describe('requireEnv', () => {
  const KEY = 'STORIX_TEST_REQUIRE_ENV';

  afterEach(() => {
    delete process.env[KEY];
  });

  it('값이 설정되어 있으면 그대로 반환한다', () => {
    process.env[KEY] = 'value';

    expect(requireEnv(KEY)).toBe('value');
  });

  it('값이 없으면 예외를 던진다', () => {
    delete process.env[KEY];

    expect(() => requireEnv(KEY)).toThrow();
  });

  it('빈 문자열이면 예외를 던진다', () => {
    process.env[KEY] = '';

    expect(() => requireEnv(KEY)).toThrow();
  });
});
