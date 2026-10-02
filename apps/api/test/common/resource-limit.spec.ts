import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  resolveEffectiveLimit,
  resolveGlobalMaxFileSizeBytes,
  resolveMaxFileSizeBytes,
  resolveCountLimits,
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
  ])(
    'namespace 재정의 $namespaceValue와 전역 100에서 $expected를 반환한다',
    ({ namespaceValue, expected }) => {
      expect(resolveMaxFileSizeBytes(namespaceValue, 100)).toBe(expected);
    },
  );
});

describe('resolveMaxFileSizeBytes with default and ceiling', () => {
  it('uses default when no namespace override exists and caps override at ceiling', () => {
    expect(resolveMaxFileSizeBytes(null, 100, 50)).toBe(50);
    expect(resolveMaxFileSizeBytes('80', 100, 50)).toBe(80);
    expect(resolveMaxFileSizeBytes('120', 100, 50)).toBe(100);
  });
});

describe('resolveCountLimits', () => {
  it('기본값과 ceiling 조합을 적용하고 기본값이 ceiling을 넘으면 거부한다', () => {
    expect(resolveCountLimits(undefined, undefined)).toEqual({ defaultValue: 10000, ceilingValue: 10000 });
    expect(resolveCountLimits('500', undefined)).toEqual({ defaultValue: 500, ceilingValue: 500 });
    expect(resolveCountLimits(undefined, '20000')).toEqual({ defaultValue: 20000, ceilingValue: 20000 });
    expect(resolveCountLimits('500', '1000')).toEqual({ defaultValue: 500, ceilingValue: 1000 });
    expect(() => resolveCountLimits('1001', '1000')).toThrow('count default exceeds ceiling');
    expect(resolveCountLimits(undefined, undefined, 1_000_000)).toEqual({
      defaultValue: 1_000_000,
      ceilingValue: 1_000_000,
    });
  });
});
