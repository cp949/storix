import { getDbDriver, type DbDriver } from '../common/db-driver.js';
import { parsePositiveInt, requireEnv } from '../common/env-parsing.js';

export type DbConfig =
  | { readonly driver: 'sqlite'; readonly sqlitePath: string }
  | {
      readonly driver: 'postgres';
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly password: string;
      readonly database: string;
    };

// 매 호출마다 process.env를 다시 읽는다(getDbDriver()와 동일한 방식) — 부팅
// 시점에 한 번 얼려서 export하면 dialect-column-types.ts류의 module-load-순서
// 문제를 여기서도 재도입하게 된다.
export function loadDbConfig(driver: DbDriver = getDbDriver()): DbConfig {
  if (driver === 'sqlite') {
    return { driver: 'sqlite', sqlitePath: requireEnv('STORIX_DB_SQLITE_PATH') };
  }

  return {
    driver: 'postgres',
    host: requireEnv('STORIX_DB_HOST'),
    port: parsePositiveInt(process.env.STORIX_DB_PORT, 5432),
    username: requireEnv('STORIX_DB_USERNAME'),
    password: requireEnv('STORIX_DB_PASSWORD'),
    database: requireEnv('STORIX_DB_NAME'),
  };
}
