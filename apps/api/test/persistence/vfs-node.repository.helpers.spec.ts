import { chunked } from '../../src/persistence/vfs-node.repository.helpers.js';

describe('chunked', () => {
  it('지정한 크기로 순서를 유지하며 나눈다', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('크기의 배수면 마지막 청크도 가득 찬다', () => {
    expect(chunked([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('빈 배열이면 청크가 없다', () => {
    expect(chunked([], 500)).toEqual([]);
  });

  it('크기가 1 미만이거나 정수가 아니면 거부한다', () => {
    expect(() => chunked([1], 0)).toThrow('Invalid chunk size');
    expect(() => chunked([1], 1.5)).toThrow('Invalid chunk size');
  });
});
