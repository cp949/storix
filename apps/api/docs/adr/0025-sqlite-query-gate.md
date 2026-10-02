# SQLite는 단일 연결 앞에 FIFO 쿼리 게이트를 두어 모든 쿼리를 직렬화한다

TypeORM better-sqlite3 드라이버는 DataSource당 연결 하나와 QueryRunner 하나를 모든 호출자에게 재사용한다.
게이트 도입 전 앱에는 쿼리 직렬화 장치가 없었다.
typeorm 1.1.1과 better-sqlite3 12.11.1에서 다음 결함을 실측했다.

- 같은 틱에 시작한 두 트랜잭션은 모두 `BEGIN`을 실행한다.
  두 번째는 `cannot start a transaction within a transaction`으로 실패한다.
  TypeORM은 `BEGIN` 실행 뒤에 `transactionDepth`를 올린다.
- 첫 `BEGIN` 이후 시작한 트랜잭션은 오류 없이 `SAVEPOINT`로 중첩된다.
  첫 트랜잭션이 롤백되면 뒤 트랜잭션의 커밋도 사라진다.
  뒤 트랜잭션은 성공을 반환한다.
- 트랜잭션 밖 쿼리가 열린 트랜잭션에 섞인다.
  커밋 전 쓰기를 읽을 수 있다.
  열린 트랜잭션이 롤백되면 자기 쓰기도 사라진다.

HTTP 요청은 트랜잭션 안에 실제 비동기 I/O가 있을 때 겹친다.
DB 작업만 하는 요청은 마이크로태스크로 끝나 다른 요청이 끼어들 경계가 없다.
결함 재현 경로는 스냅샷 본문 조회였다.
이 경로는 트랜잭션 안에서 `storage.get`을 기다린다.
이 트랜잭션이 늦게 롤백되면 그동안 `201`을 받은 다른 요청의 쓰기가 사라졌다.
재현 테스트는 `mutation-concurrency.sqlite.integration-spec.ts`다.
설계와 보장 범위는 `docs/design/01-db-driver-portability.md`에 둔다.

## 결정

`TypeOrmModule.forRootAsync`의 `dataSourceFactory`는 DataSource 초기화 직후 `installSqliteGate`를 호출한다.
구현은 `persistence/sqlite-gate.ts`다.
PostgreSQL 경로는 바꾸지 않는다.

- 연결 하나를 유지하고 모든 쿼리를 FIFO 게이트로 직렬화한다.
  트랜잭션은 끝날 때까지 게이트를 유지한다.
  다른 트랜잭션과 트랜잭션 밖 쿼리는 그동안 대기한다.
  쿼리마다 게이트를 한 번 통과한다.
- `createQueryRunner`는 호출마다 새 runner를 만든다.
  트랜잭션 소유자를 runner 인스턴스로 구분한다.
  `queryRunner.manager`는 원본 runner에 연결돼 있다.
  Proxy로 감싸면 manager 경유 쿼리가 게이트를 우회한다.
- 트랜잭션 콜백의 AsyncLocalStorage 범위에서는 소유 runner를 재사용한다.
  manager 없이 실행한 쿼리와 중첩 트랜잭션도 이 runner를 받는다.
  기존 공유 runner의 SAVEPOINT 중첩과 트랜잭션 안 쿼리 동작을 유지한다.
- 대기가 30초(`SQLITE_GATE_WAIT_TIMEOUT_MS`)를 넘으면 쿼리를 실행하지 않는다.
  `SqliteGateTimeoutError`로 실패한다.
  응답은 503 `DB_BUSY`와 `Retry-After: 1`이다.
  5xx는 receipt로 저장하지 않아 같은 key로 재시도할 수 있다.

## Considered Options

- **트랜잭션에만 mutex 적용**:
  - 트랜잭션 밖 쿼리의 dirty read와 롤백 소실을 막지 못한다.
  - `VfsMutationReceiptRepository.claim`은 트랜잭션 밖 `INSERT`다.
  - 이 쿼리가 섞이면 idempotency가 깨진다.
- **연결 여러 개 + WAL + `BEGIN IMMEDIATE` + `busy_timeout`**:
  - 읽기를 병행할 수 있다.
  - TypeORM better-sqlite3 드라이버를 풀 구조로 교체해야 한다.
  - SQLite는 writer가 하나라 이득이 작다.
  - `:memory:` 테스트 동작도 달라진다.
- **ORM 교체**:
  - Knex, Kysely, MikroORM 7은 단일 SQLite 연결에 mutex나 크기 1의 풀을 적용한다.
  - 이 게이트와 같은 직렬화 방식이다.
  - Prisma 7의 better-sqlite3 어댑터와 Sequelize `:memory:`도 같은 결함을 재현했다.
  - Drizzle은 동기 트랜잭션 콜백만 허용한다.
  - 교체 대상은 당시 비테스트 코드의 약 45%와 테스트 픽스처 전체다.
  - 어느 대안도 SQLite에서 `FOR UPDATE`와 `REPEATABLE READ`를 지원하지 않는다.
- **트랜잭션 콜백의 manager 없는 쿼리를 교착 상태로 두고 호출부 수정**:
  - 요청 사이 격리 결함을 해결하는 범위를 넘는 리팩터링이다.
- **게이트 대기 중 클라이언트 취소 처리**:
  - Nest는 요청을 취소하지 않는다.
  - 필요가 확인되지 않아 도입하지 않았다.

## Consequences

- SQLite에는 읽기 동시성이 없다.
  트랜잭션이 열려 있으면 다른 요청의 읽기도 기다린다.
  better-sqlite3는 동기 실행이므로 제한되는 동시성은 트랜잭션 진행 중의 읽기다.
  스냅샷 본문 조회는 트랜잭션 안에서 스토리지 stream을 여는 동안 게이트를 유지한다.
- 콜백 안에서 manager 없이 실행한 쓰기는 이전처럼 해당 트랜잭션과 함께 롤백된다.
  이 호출부는 변경하지 않았다.
- `DB_BUSY`(503)는 SQLite 전용 오류 코드다.
  대기 상한은 코드 상수로 두고 설정에 노출하지 않는다.
- 게이트는 Nest 앱의 DataSource에만 적용한다.
  마이그레이션과 별도 프로세스 잡의 `AppDataSource`는 대상이 아니다.
  프로세스 사이의 파일 경합(`busy_timeout`)은 다루지 않는다.
  SQLite의 단일 프로세스 배포 전제는 유지한다.
- SQLite에서도 동시 요청의 `sourceRevision` 비교·캡처 원자성과 receipt claim의 idempotency가 성립한다.
  api ADR-0024에 기록된 SQLite 동시성 한계는 이 결정으로 해소된다.
- 트랜잭션 안에서 외부 I/O를 오래 기다리면 모든 요청이 대기한다.
  트랜잭션 안에 외부 I/O를 새로 추가하지 않는다.
