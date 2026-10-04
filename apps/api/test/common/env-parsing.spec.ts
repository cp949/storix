import {
  MAX_TCP_PORT,
  MAX_TIMER_MS,
  parseBoolean,
  parseListenPort,
  parseOptionalString,
  parsePositiveInt,
  requireEnv,
} from '../../src/common/env-parsing.js';

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

  // Number()가 받아들이는 표기를 거부해 운영자가 의도한 값과 해석된 값이 어긋나지 않게 한다. GitHub 이슈 #15.
  it.each(['1e3', '0x10', ' 5 ', '+5', '5.0', '05', '-1', '1.5', ' ', '1_000', 'Infinity'])(
    '정수 표기가 아닌 %j는 거부한다',
    (value) => {
      expect(() => parsePositiveInt(value, 5432)).toThrow('잘못된 정수 환경변수 값');
    },
  );

  it('안전 정수 범위를 넘는 값은 거부한다', () => {
    expect(parsePositiveInt('9007199254740991', 1)).toBe(9007199254740991);
    expect(() => parsePositiveInt('9007199254740992', 1)).toThrow('잘못된 정수 환경변수 값');
  });

  it('max를 주면 max까지 허용하고 넘으면 거부한다', () => {
    expect(parsePositiveInt(String(MAX_TCP_PORT), 5432, MAX_TCP_PORT)).toBe(65535);
    expect(() => parsePositiveInt('65536', 5432, MAX_TCP_PORT)).toThrow('잘못된 정수 환경변수 값');
  });

  it('max를 주어도 fallback은 검사하지 않고 그대로 돌려준다', () => {
    expect(parsePositiveInt(undefined, 5432, MAX_TCP_PORT)).toBe(5432);
  });

  it('타이머 상한은 setTimeout이 받는 32비트 부호 있는 정수의 최댓값이다', () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
  });
});

describe('parseListenPort', () => {
  it('값이 없거나 빈 문자열이면 기본 포트 3000을 반환한다', () => {
    expect(parseListenPort(undefined)).toBe(3000);
    expect(parseListenPort('')).toBe(3000);
  });

  it.each([
    ['0', 0],
    ['3000', 3000],
    ['8080', 8080],
    ['65535', 65535],
  ])('유효한 포트 %j는 %d로 변환한다', (value, expected) => {
    expect(parseListenPort(value)).toBe(expected);
  });

  // listen()은 문자열을 받으면 포트가 아니라 UNIX socket 경로나 Number() 해석으로 처리한다.
  it.each([
    '3000abc',
    '0x1F90',
    '1e3',
    ' 3000',
    '3000 ',
    '+3000',
    '-1',
    '03000',
    '3000.0',
    '65536',
    'abc',
    ' ',
  ])('포트로 해석할 수 없거나 범위를 벗어난 %j는 거부한다', (value) => {
    expect(() => parseListenPort(value)).toThrow('잘못된 정수 환경변수 값');
  });
});

describe('parseBoolean', () => {
  it('값이 없으면 fallback을 반환한다', () => {
    expect(parseBoolean(undefined, false, 'X')).toBe(false);
    expect(parseBoolean(undefined, true, 'X')).toBe(true);
  });

  it('빈 문자열이면 fallback을 반환한다', () => {
    expect(parseBoolean('', true, 'X')).toBe(true);
    expect(parseBoolean('', false, 'X')).toBe(false);
  });

  it('대소문자 구분 없이 true를 인식한다', () => {
    expect(parseBoolean('true', false, 'X')).toBe(true);
    expect(parseBoolean('TRUE', false, 'X')).toBe(true);
    expect(parseBoolean('True', false, 'X')).toBe(true);
  });

  it('대소문자 구분 없이 false를 인식한다', () => {
    expect(parseBoolean('false', true, 'X')).toBe(false);
    expect(parseBoolean('FALSE', true, 'X')).toBe(false);
    expect(parseBoolean('False', true, 'X')).toBe(false);
  });

  // true/false 외의 값을 조용히 false로 처리하면 STORIX_STORAGE_USE_SSL=1이 평문 연결이 되는 등
  // 운영자 의도와 반대로 동작한다.
  it.each(['1', '0', 'yes', 'no', 'on', 'off', 'ture', ' true', 'true ', ' '])(
    'true·false가 아닌 %j는 거부한다',
    (value) => {
      expect(() => parseBoolean(value, false, 'STORIX_X')).toThrow('잘못된 불리언 환경변수 값');
    },
  );

  it('오류 메시지에 변수 이름과 값을 담는다', () => {
    expect(() => parseBoolean('yes', false, 'STORIX_STORAGE_USE_SSL')).toThrow('STORIX_STORAGE_USE_SSL=yes');
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
