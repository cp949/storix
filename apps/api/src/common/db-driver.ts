import type { DataSourceOptions } from 'typeorm';

export type DbDriver = 'postgres' | 'sqlite';

export function getDbDriver(driver?: string): DbDriver {
  return (driver ?? process.env.STORIX_DB_DRIVER) === 'sqlite' ? 'sqlite' : 'postgres';
}

export function isSqliteDataSource(options: DataSourceOptions): boolean {
  return options.type === 'better-sqlite3';
}
