import { resolveEffectiveLimit } from './resource-limit.js';

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
});
