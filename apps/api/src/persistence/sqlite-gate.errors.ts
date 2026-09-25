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
