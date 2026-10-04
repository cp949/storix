const TIMESTAMP_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;

/**
 * 목록 cursor가 SQL의 `timestamptz`로 바인딩하는 정렬 키를 검사한다.
 * 형식만 맞고 존재하지 않는 날짜(`2026-02-30`)나 PostgreSQL이 받지 않는 `0000`년은 거부한다.
 * 밀리초까지 `Date` 왕복 결과가 같아야 한다. V8은 존재하지 않는 날짜를 다음 달로 넘기기 때문이다.
 */
export function isValidTimestampKey(key: string): boolean {
  if (!TIMESTAMP_KEY.test(key) || key.startsWith('0000')) return false;
  const millis = `${key.slice(0, 23)}Z`;
  return !Number.isNaN(Date.parse(millis)) && new Date(millis).toISOString() === millis;
}
