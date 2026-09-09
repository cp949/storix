import { getDbDriver, isSqliteDataSource } from './db-driver.js';

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

  it('override가 sqlite가 아니면 postgres를 반환한다', () => {
    expect(getDbDriver('postgres')).toBe('postgres');
    expect(getDbDriver('sqllite')).toBe('postgres');
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
