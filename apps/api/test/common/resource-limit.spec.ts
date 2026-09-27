import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  resolveEffectiveLimit,
  resolveGlobalMaxFileSizeBytes,
  resolveMaxFileSizeBytes,
} from '../../src/common/resource-limit.js';

describe('resolveEffectiveLimit', () => {
  it('namespace 값이 없으면(null) 전역값을 그대로 반환한다', () => {
    expect(resolveEffectiveLimit(null, 100)).toBe(100);
  });

  it('namespace 값이 전역값보다 작으면 namespace 값을 반환한다', () => {
    expect(resolveEffectiveLimit(50, 100)).toBe(50);
  });

  it('namespace 값이 전역값보다 크면 전역값을 상한으로 반환한다', () => {
    expect(resolveEffectiveLimit(200, 100)).toBe(100);
  });

  it('namespace 값이 전역값과 같으면 그 값을 반환한다', () => {
    expect(resolveEffectiveLimit(100, 100)).toBe(100);
  });

  it('namespace 값이 NaN이면 fail-open되지 않고 전역값을 반환한다', () => {
    expect(resolveEffectiveLimit(NaN, 100)).toBe(100);
  });
});

describe('resolveGlobalMaxFileSizeBytes', () => {
  it.each([undefined, ''])('전역 값이 %p이면 기본값 5368709120을 반환한다', (value) => {
    expect(resolveGlobalMaxFileSizeBytes(value)).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(5368709120);
  });

  it('양의 정수가 아니면 예외를 던진다', () => {
    expect(() => resolveGlobalMaxFileSizeBytes('0')).toThrow();
  });
});

describe('resolveMaxFileSizeBytes', () => {
  it.each([
    { namespaceValue: null, expected: 100 },
    { namespaceValue: undefined, expected: 100 },
    { namespaceValue: '50', expected: 50 },
    { namespaceValue: '200', expected: 100 },
  ])('namespace 재정의 $namespaceValue와 전역 100에서 $expected를 반환한다', ({ namespaceValue, expected }) => {
    expect(resolveMaxFileSizeBytes(namespaceValue, 100)).toBe(expected);
  });
});
