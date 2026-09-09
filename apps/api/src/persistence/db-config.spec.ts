import { loadDbConfig } from './db-config.js';

describe('loadDbConfig', () => {
  const KEYS = [
    'STORIX_DB_DRIVER',
    'STORIX_DB_SQLITE_PATH',
    'STORIX_DB_HOST',
    'STORIX_DB_PORT',
    'STORIX_DB_USERNAME',
    'STORIX_DB_PASSWORD',
    'STORIX_DB_NAME',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  it("driver override로 'sqlite'를 주면 STORIX_DB_SQLITE_PATH로 sqlite 설정을 만든다", () => {
    process.env.STORIX_DB_SQLITE_PATH = '/data/storix.sqlite';

    expect(loadDbConfig('sqlite')).toEqual({
      driver: 'sqlite',
      sqlitePath: '/data/storix.sqlite',
    });
  });

  it('sqlite인데 STORIX_DB_SQLITE_PATH가 없으면 예외를 던진다', () => {
    expect(() => loadDbConfig('sqlite')).toThrow();
  });

  it("driver override로 'postgres'를 주면 STORIX_DB_* 값들로 postgres 설정을 만든다", () => {
    process.env.STORIX_DB_HOST = 'db.internal';
    process.env.STORIX_DB_PORT = '6543';
    process.env.STORIX_DB_USERNAME = 'storix';
    process.env.STORIX_DB_PASSWORD = 'secret';
    process.env.STORIX_DB_NAME = 'storix_db';

    expect(loadDbConfig('postgres')).toEqual({
      driver: 'postgres',
      host: 'db.internal',
      port: 6543,
      username: 'storix',
      password: 'secret',
      database: 'storix_db',
    });
  });

  it('STORIX_DB_PORT가 없으면 5432를 기본값으로 쓴다', () => {
    process.env.STORIX_DB_HOST = 'db.internal';
    process.env.STORIX_DB_USERNAME = 'storix';
    process.env.STORIX_DB_PASSWORD = 'secret';
    process.env.STORIX_DB_NAME = 'storix_db';

    const config = loadDbConfig('postgres');

    expect(config.driver === 'postgres' && config.port).toBe(5432);
  });

  it('postgres인데 STORIX_DB_HOST가 없으면 예외를 던진다', () => {
    process.env.STORIX_DB_USERNAME = 'storix';
    process.env.STORIX_DB_PASSWORD = 'secret';
    process.env.STORIX_DB_NAME = 'storix_db';

    expect(() => loadDbConfig('postgres')).toThrow();
  });

  it('override가 없으면 process.env.STORIX_DB_DRIVER로 판단한다', () => {
    process.env.STORIX_DB_DRIVER = 'sqlite';
    process.env.STORIX_DB_SQLITE_PATH = '/data/storix.sqlite';

    expect(loadDbConfig()).toEqual({
      driver: 'sqlite',
      sqlitePath: '/data/storix.sqlite',
    });
  });
});
