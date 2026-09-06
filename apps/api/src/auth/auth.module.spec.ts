import { resolveValidApiKeys } from './auth.module.js';

describe('resolveValidApiKeys', () => {
  it('이전 키가 없으면 현재 키만 담은 배열을 반환한다', () => {
    expect(resolveValidApiKeys('current-key', undefined)).toEqual(['current-key']);
  });

  it('이전 키가 있으면 현재 키와 이전 키를 모두 담은 배열을 반환한다', () => {
    expect(resolveValidApiKeys('current-key', 'previous-key')).toEqual(['current-key', 'previous-key']);
  });

  it('이전 키가 빈 문자열이면 현재 키만 담은 배열을 반환한다', () => {
    expect(resolveValidApiKeys('current-key', '')).toEqual(['current-key']);
  });
});
