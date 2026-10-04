# TRP-006 TypeORM SQLite runner는 SQLite 자동 롤백 뒤 트랜잭션 상태를 정리하지 않는다

- 상태: ACTIVE
- 적용 조건: SQLite 쿼리 게이트(`persistence/sqlite-gate.ts`)나 TypeORM runner의 `isTransactionActive`·`transactionDepth`에 의존해 트랜잭션 종료를 판단하는 코드를 추가하거나 바꿀 때.

## 오해하기 쉬운 신호

`EntityManager.transaction()`이 오류를 던지고 끝났으므로 트랜잭션이 정리됐다고 보인다.
평상시 롤백 경로의 테스트는 모두 통과한다.
자동 롤백 뒤에는 게이트가 해제되지 않아 이후 모든 쿼리가 30초 대기 뒤 503 `DB_BUSY`가 된다.
디스크를 비워도 프로세스를 재시작할 때까지 복구되지 않는다.
GitHub 이슈 #22가 이 경로로 발견됐다.

## 원인

- SQLite는 `SQLITE_FULL`·`SQLITE_IOERR`·`SQLITE_NOMEM` 등에서 트랜잭션을 자동 롤백한다. 이때 연결의 `inTransaction`이 false가 된다.
- TypeORM은 `ROLLBACK` 성공 뒤에만 `isTransactionActive = false`로 바꾸고, `ROLLBACK TO SAVEPOINT` 성공 뒤에만 `transactionDepth`를 줄인다.
- 자동 롤백 뒤 `ROLLBACK`은 `no transaction is active`로 실패하므로 두 값이 그대로 남는다.
- `EntityManager.transaction()`은 롤백 오류를 삼킨다. 호출자에게는 원래 오류만 보인다.
- 두 값으로 해제 시점을 정하는 코드는 해제하지 못한다.

## 탐지/회피

- 탐지: 트랜잭션 종료 판단이 `isTransactionActive`·`transactionDepth`만 보는지 확인한다.
- 회피: 게이트가 트랜잭션·SAVEPOINT 깊이를 직접 세고(`GatedQueryRunner.gateDepth`) 연결의 `inTransaction`으로 자동 롤백을 판별한다. 설계는 `docs/design/01-db-driver-portability.md` "SQLite 쿼리 게이트"다.
- 회귀 검증: `apps/api/test/persistence/sqlite-gate.spec.ts`가 `:memory:` DB와 `PRAGMA max_page_count`로 실제 `SQLITE_FULL`을 일으켜 확인한다. `ROLLBACK`만 실패시키는 mock으로 깊이 0인데 트랜잭션이 남는 분기를 확인한다.
- 남는 위험: `COMMIT` 자체가 `SQLITE_BUSY` 등으로 실패하는 경로는 재현하지 않았다. 단일 연결·단일 프로세스 전제에서는 발생하지 않는다고 판단했으나 검증하지 않았다.
