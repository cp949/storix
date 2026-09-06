import { parseRange } from './range.js';
import { VfsRangeNotSatisfiableError } from './vfs.errors.js';

describe('parseRange', () => {
  it('bytes=start-end 형식을 파싱한다', () => {
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
  });

  it('열린 끝(bytes=start-)은 size-1까지로 채운다', () => {
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
  });

  it('suffix range(bytes=-N)는 마지막 N byte로 변환한다', () => {
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
  });

  it('suffix range가 size보다 크면 0부터 시작한다', () => {
    expect(parseRange('bytes=-100', 10)).toEqual({ start: 0, end: 9 });
  });

  it('end가 size를 넘으면 size-1로 잘라낸다', () => {
    expect(parseRange('bytes=0-1000', 10)).toEqual({ start: 0, end: 9 });
  });

  it('여러 range(콤마)는 거부한다', () => {
    expect(() => parseRange('bytes=0-1,3-4', 10)).toThrow(VfsRangeNotSatisfiableError);
  });

  it('bytes= 접두어가 없으면 거부한다', () => {
    expect(() => parseRange('0-1', 10)).toThrow(VfsRangeNotSatisfiableError);
  });

  it('start와 end가 모두 없으면 거부한다', () => {
    expect(() => parseRange('bytes=-', 10)).toThrow(VfsRangeNotSatisfiableError);
  });

  it('end가 start보다 작으면 거부한다', () => {
    expect(() => parseRange('bytes=5-2', 10)).toThrow(VfsRangeNotSatisfiableError);
  });

  it('start가 size 이상이면 거부한다', () => {
    expect(() => parseRange('bytes=10-15', 10)).toThrow(VfsRangeNotSatisfiableError);
  });

  it('size가 0이면 항상 거부한다', () => {
    expect(() => parseRange('bytes=0-0', 0)).toThrow(VfsRangeNotSatisfiableError);
  });
});
