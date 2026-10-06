import { firstQueryValue } from '../../src/document-archive/http-query.js';

describe('firstQueryValue', () => {
  it('배열이면 첫 번째 값을 반환한다', () => {
    expect(firstQueryValue(['/a.txt', '/b.txt'])).toBe('/a.txt');
  });

  it('단일 값이면 그대로 반환한다', () => {
    expect(firstQueryValue('/a.txt')).toBe('/a.txt');
  });

  it('undefined면 undefined를 반환한다', () => {
    expect(firstQueryValue(undefined)).toBeUndefined();
  });
});
