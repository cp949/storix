import {
  optionalConsistencyParam,
  optionalCursorParam,
  optionalNameFilterParam,
} from '../../src/vfs/query-params.js';

describe('query-params', () => {
  describe('optionalCursorParam', () => {
    it('생략과 문자열은 그대로 돌려준다', () => {
      expect(optionalCursorParam(undefined)).toBeUndefined();
      expect(optionalCursorParam('abc')).toBe('abc');
      expect(optionalCursorParam('')).toBe('');
    });

    it.each([[['a', 'b']], [{ a: 'b' }], [1]])(
      '문자열이 아니면 VFS_INVALID_CURSOR로 거절한다: %j',
      (value) => {
        expect(() => optionalCursorParam(value)).toThrow(
          expect.objectContaining({ code: 'VFS_INVALID_CURSOR' }),
        );
      },
    );
  });

  describe('optionalNameFilterParam', () => {
    it('생략, 빈 문자열, 일반 문자열은 그대로 돌려준다', () => {
      expect(optionalNameFilterParam(undefined)).toBeUndefined();
      expect(optionalNameFilterParam('')).toBe('');
      expect(optionalNameFilterParam('보고서_2026%')).toBe('보고서_2026%');
    });

    it('슬래시처럼 이름에 쓸 수 없는 문자도 부분 검색을 위해 허용한다', () => {
      expect(optionalNameFilterParam('a/b')).toBe('a/b');
    });

    it.each([[['a', 'b']], [{ a: 'b' }], ['a\u0000b'], ['\u0000']])(
      '문자열이 아니거나 NUL을 포함하면 VFS_INVALID_QUERY로 거절한다: %j',
      (value) => {
        expect(() => optionalNameFilterParam(value)).toThrow(
          expect.objectContaining({ code: 'VFS_INVALID_QUERY', status: 400 }),
        );
      },
    );
  });

  describe('optionalConsistencyParam', () => {
    it('생략은 undefined, revision은 그대로 돌려준다', () => {
      expect(optionalConsistencyParam(undefined)).toBeUndefined();
      expect(optionalConsistencyParam('revision')).toBe('revision');
    });

    it.each([[''], ['snapshot'], ['Revision'], [' revision'], [['revision', 'revision']], [{ a: 'b' }], [1]])(
      'revision이 아닌 값은 VFS_INVALID_QUERY로 거절한다: %j',
      (value) => {
        expect(() => optionalConsistencyParam(value)).toThrow(
          expect.objectContaining({ code: 'VFS_INVALID_QUERY', status: 400 }),
        );
      },
    );
  });
});
