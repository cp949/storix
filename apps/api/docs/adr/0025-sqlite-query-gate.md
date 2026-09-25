# SQLite는 단일 연결 앞에 FIFO 쿼리 게이트를 두어 모든 쿼리를 직렬화한다

TypeORM better-sqlite3 드라이버는 DataSource당 연결 하나와 QueryRunner 하나를 모든 호출자에게 재사용한다. 앱에는 직렬화
장치가 없어 동시 요청이 다음 세 방식으로 서로를 망가뜨린다(typeorm 1.1.1, better-sqlite3 12.11.1 실측).

- 같은 틱에 시작한 두 트랜잭션은 둘 다 `BEGIN`을 실행해 두 번째가 `cannot start a transaction within a transaction`으로 실패한다.
  TypeORM이 `BEGIN` 실행 뒤에야 `transactionDepth`를 올리기 때문이다.
- 첫 트랜잭션의 `BEGIN`이 끝난 뒤 시작한 트랜잭션은 오류 없이 `SAVEPOINT`로 중첩된다. 첫 트랜잭션이 롤백되면 뒤 트랜잭션의
  커밋도 함께 사라지는데 뒤 트랜잭션은 성공을 반환한다.
- 트랜잭션 밖 쿼리는 열린 트랜잭션에 섞인다. 커밋 전 쓰기를 읽고, 그 트랜잭션이 롤백되면 자기 쓰기도 사라진다.

HTTP 수준에서는 트랜잭션 안에 실제 비동기 I/O가 있을 때만 요청이 겹친다. DB 작업만 하는 요청은 마이크로태스크로 끝나 끼어들
경계가 없다. 현재 그 경로는 스냅샷 본문 조회(`storage.get`을 트랜잭션 안에서 기다림)다. 이 트랜잭션이 늦게 롤백되면 그동안
`201`을 받은 다른 요청의 쓰기가 사라졌다(재현 테스트 `mutation-concurrency.sqlite.integration-spec.ts`). 설계와 보장 범위는
`docs/design/01-db-driver-portability.md`가 기술한다.

## 결정

`TypeOrmModule.forRootAsync`의 `dataSourceFactory`가 DataSource 초기화 직후 `installSqliteGate`(`persistence/sqlite-gate.ts`)를
호출한다. PostgreSQL 경로는 바뀌지 않는다.

- 연결은 하나로 유지하고 모든 쿼리를 FIFO 게이트로 직렬화한다. 트랜잭션은 게이트를 끝까지 쥐고, 다른 트랜잭션과 트랜잭션 밖 쿼리는
  그동안 대기한다. 쿼리 하나마다 게이트를 한 번 통과한다.
- `createQueryRunner`는 호출마다 새 runner를 만든다. 트랜잭션 소유자를 runner 인스턴스로 구분하기 위해서다.
  `queryRunner.manager`가 원본 runner에 붙어 있어 Proxy로 감싸는 방식은 manager 경유 쿼리가 게이트를 우회한다.
- 트랜잭션 콜백 안에서 manager 없이 실행한 쿼리와 다시 연 트랜잭션은 소유 runner를 그대로 받는다(AsyncLocalStorage 범위).
  기존 공유 runner와 같은 동작(SAVEPOINT 중첩, 트랜잭션 안 쿼리)을 유지한다.
- 대기가 30초(`SQLITE_GATE_WAIT_TIMEOUT_MS`)를 넘으면 그 쿼리는 실행하지 않고 `SqliteGateTimeoutError`(503 `DB_BUSY`,
  `Retry-After: 1`)로 실패한다. 5xx라 receipt로 저장하지 않으므로 같은 key로 재시도할 수 있다.

## Considered Options

- **트랜잭션에만 mutex**: 트랜잭션 밖 쿼리의 dirty read와 롤백 소실을 막지 못한다. `VfsMutationReceiptRepository.claim`이
  트랜잭션 밖 `INSERT`라 idempotency가 깨진다.
- **연결 여러 개 + WAL + `BEGIN IMMEDIATE` + `busy_timeout`**: 읽기가 병행되지만 TypeORM better-sqlite3 드라이버를 풀 구조로
  갈아 끼워야 한다. SQLite는 writer가 하나라 이득이 작고 `:memory:` 테스트가 달라진다.
- **ORM 교체**: Knex, Kysely, MikroORM 7은 SQLite 연결 하나에 뮤텍스나 풀 크기 1을 씌워 직렬화하고(같은 접근이다), Prisma 7의
  better-sqlite3 어댑터와 Sequelize `:memory:`는 같은 결함을 재현하며, Drizzle은 동기 트랜잭션 콜백만 허용한다. 대상은 비테스트
  코드의 약 45%와 테스트 픽스처 전체이고, 어느 쪽도 SQLite에서 `FOR UPDATE`와 `REPEATABLE READ`를 지원하지 않는다.
- **트랜잭션 안의 트랜잭션 밖 경로 쿼리를 교착으로 두고 호출부를 전부 수정**: 이번 결함의 범위(요청 사이 격리)를 넘는 리팩터링이다.
- **게이트 대기 중 클라이언트 취소 처리**: Nest는 요청을 취소하지 않는다. 필요가 확인되지 않아 두지 않았다.

## Consequences

- SQLite에서 읽기 동시성은 없다. 트랜잭션이 열려 있는 동안 다른 요청의 읽기도 기다린다. better-sqlite3가 동기 실행이라 잃는 것은
  "트랜잭션 진행 중 읽기"뿐이다. 스냅샷 본문 조회는 트랜잭션 안에서 스토리지 stream을 여는 동안 게이트를 쥔다.
- 트랜잭션 콜백 안에서 manager 없이 실행한 쓰기는 이전처럼 그 트랜잭션과 함께 롤백된다. 이 호출부는 정리하지 않았다.
- `DB_BUSY`(503)는 SQLite에서만 나오는 새 오류 코드다. 대기 상한은 코드 상수이고 설정으로 노출하지 않는다.
- 게이트는 Nest 앱의 DataSource에만 건다. 마이그레이션과 별도 프로세스 잡(`AppDataSource`)은 대상이 아니다. 프로세스 사이의 파일
  경합(`busy_timeout`)은 다루지 않는다. SQLite는 단일 프로세스 배포 전용이라는 전제가 유지된다.
- `sourceRevision` 비교와 캡처의 원자성, receipt claim의 idempotency가 SQLite에서도 동시 요청에 대해 성립한다. ADR-0024가
  기록했던 SQLite 동시성 한계는 이 결정으로 해소된다.
- 트랜잭션 안에서 외부 I/O를 오래 기다리면 모든 요청이 대기한다. 트랜잭션 안에 외부 I/O를 새로 추가하지 않는다.
