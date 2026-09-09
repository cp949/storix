export function resolveBinaryColumnType(driver: string | undefined = process.env.STORIX_DB_DRIVER): 'blob' | 'bytea' {
  return driver === 'sqlite' ? 'blob' : 'bytea';
}

export function resolveTimestampColumnType(
  driver: string | undefined = process.env.STORIX_DB_DRIVER,
): 'datetime' | 'timestamptz' {
  return driver === 'sqlite' ? 'datetime' : 'timestamptz';
}

// better-sqlite3 드라이버는 TypeORM 엔티티 메타데이터의 "char" 타입을
// 지원하지 않는다(AbstractSqliteDriver.supportedDataTypes에 없음) — DDL은
// SQLite의 동적 타이핑 덕분에 char(64)로 그대로 둬도 문제없지만, 엔티티
// 컬럼의 type은 드라이버별로 갈라야 DataSource.initialize()가
// DataTypeNotSupportedError 없이 뜬다.
export function resolveFixedCharColumnType(
  driver: string | undefined = process.env.STORIX_DB_DRIVER,
): 'varchar' | 'char' {
  return driver === 'sqlite' ? 'varchar' : 'char';
}

// 모듈 로드 시점에 한 번 평가된다 — 프로세스 하나는 항상 같은 드라이버로만
// 붙으므로(운영에서 한 프로세스가 두 드라이버를 오갈 일은 없음) 이걸로
// 충분하다. 값을 나중에 바꾸려면 프로세스를 재시작해야 한다.
export const BINARY_COLUMN_TYPE = resolveBinaryColumnType();
export const TIMESTAMP_COLUMN_TYPE = resolveTimestampColumnType();
export const FIXED_CHAR_COLUMN_TYPE = resolveFixedCharColumnType();
