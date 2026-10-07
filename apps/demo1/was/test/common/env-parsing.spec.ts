import {
  MAX_TCP_PORT,
  parseOptionalString,
  parsePositiveInt,
  requireEnv,
} from '../../src/common/env-parsing.js';

describe('env-parsing', () => {
  describe('parsePositiveInt', () => {
    it('값이 없으면 fallback을 반환한다', () => {
      expect(parsePositiveInt(undefined, 300)).toBe(300);
    });

    it('양의 정수 문자열을 파싱한다', () => {
      expect(parsePositiveInt('42', 300)).toBe(42);
    });

    it('0 이하이거나 정수가 아니면 예외를 던진다', () => {
      expect(() => parsePositiveInt('0', 300)).toThrow();
      expect(() => parsePositiveInt('abc', 300)).toThrow();
    });

    it.each(['1e3', '0x10', ' 5 ', '+5', '5.0', '05', '-1', '1.5', ' ', 'Infinity'])(
      '10진 정수 표기가 아닌 %j는 예외를 던진다',
      (value) => {
        expect(() => parsePositiveInt(value, 300)).toThrow('잘못된 정수 환경변수 값');
      },
    );

    it('빈 문자열이면 fallback을 반환한다', () => {
      expect(parsePositiveInt('', 300)).toBe(300);
    });

    it('max를 주면 max까지 허용하고 넘으면 예외를 던진다', () => {
      expect(parsePositiveInt('65535', 300, MAX_TCP_PORT)).toBe(65535);
      expect(() => parsePositiveInt('65536', 300, MAX_TCP_PORT)).toThrow('잘못된 정수 환경변수 값');
    });
  });

  describe('requireEnv', () => {
    it('값이 없으면 예외를 던진다', () => {
      expect(() => requireEnv('DEMO_WAS_NOT_SET_XYZ')).toThrow();
    });

    it('값이 있으면 그대로 반환한다', () => {
      process.env.DEMO_WAS_TEST_VALUE = 'hello';
      expect(requireEnv('DEMO_WAS_TEST_VALUE')).toBe('hello');
      delete process.env.DEMO_WAS_TEST_VALUE;
    });
  });

  describe('parseOptionalString', () => {
    it('빈 문자열이나 undefined는 undefined로 정규화한다', () => {
      expect(parseOptionalString('')).toBeUndefined();
      expect(parseOptionalString(undefined)).toBeUndefined();
      expect(parseOptionalString('x')).toBe('x');
    });
  });
});
