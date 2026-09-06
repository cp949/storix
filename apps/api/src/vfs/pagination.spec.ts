import { resolveLimit } from './pagination.js';

describe('resolveLimit', () => {
  it('값이 없으면 기본값 100을 반환한다', () => {
    expect(resolveLimit(undefined)).toBe(100);
  });

  it('유효한 범위의 값은 그대로 반환한다', () => {
    expect(resolveLimit('50')).toBe(50);
  });

  it('최대값 1000을 넘으면 1000으로 clamp한다', () => {
    expect(resolveLimit('5000')).toBe(1000);
  });

  it('0 이하의 값은 기본값 100으로 대체한다', () => {
    expect(resolveLimit('0')).toBe(100);
    expect(resolveLimit('-5')).toBe(100);
  });

  it('정수가 아닌 값은 기본값 100으로 대체한다', () => {
    expect(resolveLimit('abc')).toBe(100);
  });
});
