import { parseRange } from '../../src/vfs/range.js';
import { VfsRangeNotSatisfiableError } from '../../src/vfs/vfs.errors.js';

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

  it('단위 이름은 대소문자를 구분하지 않는다', () => {
    expect(parseRange('Bytes=1-2', 10)).toEqual({ start: 1, end: 2 });
    expect(parseRange('BYTES=-3', 10)).toEqual({ start: 7, end: 9 });
  });

  it('알 수 없는 단위는 거부한다', () => {
    expect(() => parseRange('items=0-1', 10)).toThrow(VfsRangeNotSatisfiableError);
  });

  describe('309자리 이상 숫자(Number가 Infinity가 되는 값)', () => {
    const huge = '9'.repeat(400);

    it('end가 매우 크면 size-1로 잘라낸다', () => {
      expect(parseRange(`bytes=0-${huge}`, 10)).toEqual({ start: 0, end: 9 });
    });

    it('suffix가 매우 크면 전체를 돌려준다', () => {
      expect(parseRange(`bytes=-${huge}`, 10)).toEqual({ start: 0, end: 9 });
    });

    it('start가 매우 크면 거부한다', () => {
      expect(() => parseRange(`bytes=${huge}-`, 10)).toThrow(VfsRangeNotSatisfiableError);
    });
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

  it.each([
    ['유효하지 않은 문법', 'bytes=abc-def', 10],
    ['복수 범위', 'bytes=0-1,3-4', 10],
    ['빈 범위', 'bytes=-', 10],
    ['역순 범위', 'bytes=5-2', 10],
    ['파일 끝 밖 범위', 'bytes=10-15', 10],
    ['빈 파일', 'bytes=0-0', 0],
  ])('%s 거부 오류에 요청 범위와 표현 크기를 담는다', (_reason, header, size) => {
    expect(() => parseRange(header, size)).toThrow(
      expect.objectContaining({
        code: 'VFS_RANGE_NOT_SATISFIABLE',
        status: 416,
        range: header,
        representationSize: size,
      }),
    );
  });
});
