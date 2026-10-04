import { getDbDriver, isSqliteDataSource } from '../../src/common/db-driver.js';

describe('getDbDriver', () => {
  const KEY = 'STORIX_DB_DRIVER';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  it('override로 sqlite를 주면 sqlite를 반환한다', () => {
    expect(getDbDriver('sqlite')).toBe('sqlite');
  });

  it('override로 postgres를 주면 postgres를 반환한다', () => {
    expect(getDbDriver('postgres')).toBe('postgres');
  });

  // 오타가 조용히 postgres로 처리되어 간접 오류(STORIX_DB_HOST 누락 등)만 보이던 문제를 고정한다. GitHub 이슈 #15.
  it.each(['sqllite', 'SQLite', 'sqlite3', 'sqlite ', ' postgres', 'postgresql', 'POSTGRES'])(
    '지원하지 않는 값 %j는 거부한다',
    (value) => {
      expect(() => getDbDriver(value)).toThrow('STORIX_DB_DRIVER');
    },
  );

  it('환경변수의 지원하지 않는 값도 거부한다', () => {
    process.env[KEY] = 'sqlite3';
    expect(() => getDbDriver()).toThrow('STORIX_DB_DRIVER');
  });

  it('빈 문자열은 값이 없는 것으로 보고 postgres를 반환한다', () => {
    expect(getDbDriver('')).toBe('postgres');
    process.env[KEY] = '';
    expect(getDbDriver()).toBe('postgres');
  });

  it('override가 없으면 process.env.STORIX_DB_DRIVER를 읽는다', () => {
    process.env[KEY] = 'sqlite';
    expect(getDbDriver()).toBe('sqlite');
  });

  it('override도 없고 환경변수도 없으면 postgres를 반환한다', () => {
    delete process.env[KEY];
    expect(getDbDriver()).toBe('postgres');
  });
});

describe('isSqliteDataSource', () => {
  it("options.type이 'better-sqlite3'면 true를 반환한다", () => {
    expect(isSqliteDataSource({ type: 'better-sqlite3' } as never)).toBe(true);
  });

  it("options.type이 'postgres'면 false를 반환한다", () => {
    expect(isSqliteDataSource({ type: 'postgres' } as never)).toBe(false);
  });
});
