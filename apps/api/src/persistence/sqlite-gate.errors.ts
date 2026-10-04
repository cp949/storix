import { DomainError } from '../common/domain-error.js';

// SQLite 쿼리 게이트에서 대기 상한을 넘겼을 때의 오류다. 락 획득 실패이므로 요청 내용과
// 무관하고 재시도로 성공할 수 있다 — receipt로 고정하지 않는 5xx다.
export class SqliteGateTimeoutError extends DomainError {
  readonly code = 'DB_BUSY';
  readonly status = 503;
  // DomainErrorFilter가 Retry-After 헤더로 내보낸다.
  readonly retryAfterSeconds = 1;

  constructor(readonly waitTimeoutMs: number) {
    super('데이터베이스 사용 대기 시간을 초과함. 잠시 후 다시 시도해야 함');
  }
}

// SQLite가 트랜잭션을 스스로 롤백(SQLITE_FULL·SQLITE_IOERR 등)했는데 트랜잭션 소유자가
// 계속 쿼리를 보낼 때의 내부 오류다. 이 쿼리를 그대로 실행하면 autocommit으로 원자성이 깨지므로
// 실행하지 않고 실패시킨다. DomainError가 아니라 미분류 500으로 응답한다.
export class SqliteTransactionAbortedError extends Error {
  constructor() {
    super('SQLite가 트랜잭션을 자동 롤백했으므로 이 트랜잭션의 쿼리를 실행할 수 없음');
    this.name = 'SqliteTransactionAbortedError';
  }
}
