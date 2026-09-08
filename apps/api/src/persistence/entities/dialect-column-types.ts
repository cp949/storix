export function resolveBinaryColumnType(driver: string | undefined = process.env.STORIX_DB_DRIVER): 'blob' | 'bytea' {
  return driver === 'sqlite' ? 'blob' : 'bytea';
}

export function resolveTimestampColumnType(
  driver: string | undefined = process.env.STORIX_DB_DRIVER,
): 'datetime' | 'timestamptz' {
  return driver === 'sqlite' ? 'datetime' : 'timestamptz';
}

// 모듈 로드 시점에 한 번 평가된다 — 프로세스 하나는 항상 같은 드라이버로만
// 붙으므로(운영에서 한 프로세스가 두 드라이버를 오갈 일은 없음) 이걸로
// 충분하다. 값을 나중에 바꾸려면 프로세스를 재시작해야 한다.
export const BINARY_COLUMN_TYPE = resolveBinaryColumnType();
export const TIMESTAMP_COLUMN_TYPE = resolveTimestampColumnType();
