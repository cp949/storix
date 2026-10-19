// DB wall-clock 기준 deadline 판정이다. API 프로세스 시계가 아니라 DB 시계를 쓰므로 여러 인스턴스와 느린 transaction에서도
// 같은 기준을 쓴다. archive와 extract가 공유하며 어떤 오류를 던질지는 호출자가 정한다.
import type { EntityManager } from 'typeorm';

/**
 * DB 현재 wall-clock 시각을 읽는다. transaction이 열려 있어도 시작 시각이 아니라 경과한 시각이다.
 * SQLite는 타임존 없는 문자열을 돌려주므로 UTC로 해석한다.
 */
export async function readDbWallClock(manager: EntityManager, isSqlite: boolean): Promise<Date> {
  const [{ now }] = (await manager.query(
    isSqlite ? "SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS now" : 'SELECT clock_timestamp() AS now',
  )) as { now: Date | string }[];
  return now instanceof Date ? now : new Date(`${now}${now.endsWith('Z') ? '' : 'Z'}`);
}

/** DB wall-clock이 deadline 이상이면 true를 돌려준다. */
export async function isDbDeadlinePassed(
  manager: EntityManager,
  isSqlite: boolean,
  deadlineAt: Date,
): Promise<boolean> {
  const [{ expired }] = (await manager.query(
    isSqlite
      ? "SELECT julianday('now') >= julianday(?) AS expired"
      : 'SELECT clock_timestamp() >= $1::timestamptz AS expired',
    [deadlineAt.toISOString()],
  )) as { expired: boolean | number }[];
  return expired === true || expired === 1;
}
