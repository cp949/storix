import { parseOptionalString, parsePositiveInt, requireEnv } from './env-parsing.js';

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
