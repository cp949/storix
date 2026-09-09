import { DialectPlaceholders } from './dialect-placeholders.js';

describe('DialectPlaceholders', () => {
  describe('SQLite(isSqlite=true)', () => {
    it('항상 ?를 반환하고, 같은 값이라도 호출할 때마다 params에 다시 쌓는다', () => {
      const ph = new DialectPlaceholders(true);

      expect(ph.bind('a')).toBe('?');
      expect(ph.bind('a')).toBe('?');
      expect(ph.bind('b')).toBe('?');

      expect(ph.params).toEqual(['a', 'a', 'b']);
    });
  });

  describe('Postgres(isSqlite=false)', () => {
    it('호출 순서대로 $1, $2, ...를 반환하고, 같은 값이라도 재호출하면 새 번호를 매긴다', () => {
      const ph = new DialectPlaceholders(false);

      expect(ph.bind('a')).toBe('$1');
      expect(ph.bind('b')).toBe('$2');
      expect(ph.bind('a')).toBe('$3');

      expect(ph.params).toEqual(['a', 'b', 'a']);
    });
  });
});
