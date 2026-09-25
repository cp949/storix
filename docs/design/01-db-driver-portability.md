# DB 드라이버 이식 계층 (PostgreSQL / SQLite)

`apps/api`는 두 DB 드라이버를 지원한다. `postgres`(기본)와 `sqlite`(단일 프로세스 소형 배포용)이다. 이 문서는 두
드라이버가 공유하는 코드와 갈라지는 지점의 규칙을 정한다. 마이그레이션·쿼리·잡을 추가하거나 고칠 때 이 규칙을 따른다.
compose 배치는 [ADR-0022](../adr/0022-sqlite-compose-override.md), 운영 절차는 루트 `README.sqlite.md`.

## 1. 범위와 전제

- 지원 드라이버는 `postgres`와 `sqlite` 둘뿐이다. 세 번째 엔진(MySQL 등)은 목표가 아니다. 엔진이 늘면 마이그레이션·재귀
  쿼리·백업 검증 비용이 엔진 수만큼 늘고, 엔진마다 비호환 축(예: MySQL은 partial unique index가 없다)이 달라 SQLite용
  코드가 재사용되지 않는다.
- SQLite는 **단일 프로세스 배포 전용**이다. 여러 호스트가 같은 SQLite 파일을 공유하는 구성은 지원하지 않는다. 파일 락
  메커니즘이 네트워크 파일시스템에서 신뢰할 수 없다는 SQLite 공식 입장이 근거다. 이 제약은 코드로 강제하지 않고 문서로만
  알린다. 아래 SQLite 전용 처리(락 생략, GC 락 no-op, 파일 복사 복구)는 모두 이 전제 위에서 성립한다.
- 기존 PostgreSQL 배포의 동작·설정은 SQLite 지원과 무관하게 유지된다.

## 2. 드라이버 선택

| 환경변수 | 의미 |
| --- | --- |
| `STORIX_DB_DRIVER` | `postgres`(기본) 또는 `sqlite`. 그 외 값은 `postgres`로 취급한다 |
| `STORIX_DB_SQLITE_PATH` | SQLite 파일 경로. `sqlite`일 때 필수 |
| `STORIX_DB_HOST`·`PORT`·`USERNAME`·`PASSWORD`·`NAME` | `postgres`일 때만 의미가 있다 |

- 드라이버 판정은 `common/db-driver.ts`의 `getDbDriver()`(환경변수)와 `isSqliteDataSource()`(연결 옵션 `type ===
  'better-sqlite3'`)가 한다. 코드 분기는 이 둘 중 하나로만 한다.
- `loadDbConfig()`는 호출할 때마다 `process.env`를 다시 읽는다. `data-source.ts`(CLI·마이그레이션)와
  `persistence.module.ts`(런타임)가 같은 함수를 써서 두 연결이 어긋나지 않게 한다.
- **엔티티 컬럼 타입은 모듈 로드 시점에 한 번 확정된다.** 아래 3절의 컬럼 타입 상수가 `import` 시점의
  `STORIX_DB_DRIVER`를 읽어 고정하므로, `.env` 파일로만 드라이버를 지정하는 진입점은 엔티티가 있는 모듈을 `import()`하기
  전에 환경 파일을 먼저 로드해야 한다(`common/bootstrap-with-env.ts`의 `bootstrapWithEnv()`). 루트 모듈을 정적으로
  `import`하면 `.env`의 드라이버가 무시되고 Postgres 타입으로 SQLite 연결이 열린다.
- 한 프로세스는 하나의 드라이버로만 동작한다. 실행 중 전환은 지원하지 않는다.

## 3. 스키마 이식

### 3.1 마이그레이션은 히스토리 하나, 파일 안에서 분기

드라이버별 마이그레이션 세트를 따로 두지 않는다. 두 세트는 시간이 지나면서 조용히 어긋나기 쉽다. 각 마이그레이션 파일이
`queryRunner.connection.options.type`으로 DDL을 분기한다. 마이그레이션 목록은 `migrations/all-migrations.ts` 하나다.

| 항목 | PostgreSQL | SQLite |
| --- | --- | --- |
| UUID 컬럼(PK·FK) | `uuid` | `varchar(36)` |
| 타임스탬프 | `timestamptz`, `now()` | `datetime`, `datetime('now')` |
| 바이너리 | `bytea` | `blob` |
| 고정 길이 문자열 | `char(n)` | `char(n)` 그대로(SQLite는 타입 이름을 자유롭게 받는다) |
| 이름 형식 CHECK | 정규식 `~ '^[a-z0-9_-]{1,128}$'` | `NOT GLOB '*[^a-z0-9_-]*' AND length(name) BETWEEN 1 AND 128` |
| `gc_state` 테이블 | 있음 | 만들지 않음(6절) |

- SQLite에서 uuid 컬럼을 `varchar(36)`으로 쓰는 것은 마이그레이션 DDL 한정이다. 이 저장소는 마이그레이션을 손으로 쓴 SQL로
  관리하므로(`synchronize: false`) TypeORM의 타입 자동 정규화가 DDL 문자열에는 적용되지 않는다.
- 이름 형식 CHECK의 SQLite 표현에서 `GLOB '[a-z0-9_-]*'`는 쓰지 않는다. 첫 글자만 검사하고 나머지를 전부 허용한다.
  허용 문자 밖의 글자가 하나라도 있으면 거부하는 `NOT GLOB '*[^...]*'` 형태여야 한다.
- 두 드라이버가 공유하는 문법은 그대로 쓴다. row-value 비교 `(name, id) > ($1, $2)`, `ON CONFLICT ... DO UPDATE`,
  partial unique index(`WHERE status = 'ACTIVE'`)는 SQLite에서 동일하게 동작한다.

### 3.2 ID는 앱 레이어에서 생성한다

UUID PK는 DB default에 의존하지 않고 항상 애플리케이션에서 `randomUUID()`로 생성한다. SQLite 스키마에는 default가 없다.
PostgreSQL 스키마의 `DEFAULT gen_random_uuid()`는 안전망일 뿐이며 코드 경로는 이 default를 쓰지 않는다. 새 테이블을
추가할 때 raw `INSERT`로 uuid PK를 default에 맡기지 않는다. TypeORM의 `save()` 경로는 `@PrimaryGeneratedColumn('uuid')`도
클라이언트에서 생성한다.

### 3.3 엔티티 컬럼 타입

`persistence/entities/dialect-column-types.ts`가 드라이버별로 갈라지는 타입을 상수로 제공한다.

| 상수 | postgres | sqlite |
| --- | --- | --- |
| `BINARY_COLUMN_TYPE` | `bytea` | `blob` |
| `TIMESTAMP_COLUMN_TYPE` | `timestamptz` | `datetime` |
| `FIXED_CHAR_COLUMN_TYPE` | `char` | `varchar` |

- 엔티티에서 `bytea`·`timestamptz`·`char`를 직접 쓰지 않고 이 상수를 쓴다. `better-sqlite3` 드라이버는 이 타입을 지원하지
  않아 `DataSource.initialize()`가 `DataTypeNotSupportedError`로 실패한다.
- 타입을 생략하는 방법은 쓰지 않는다. `@CreateDateColumn()`을 타입 없이 두면 PostgreSQL에서 `timestamp`(tz 없음)가 되어
  저장 동작이 세션 타임존에 암묵적으로 의존한다.
- `uuid`·`jsonb` 컬럼은 갈라지지 않는다. `better-sqlite3` 드라이버가 `uuid`를 `varchar`로 정규화하고 `jsonb`를 JSON
  직렬화·역직렬화하므로 엔티티 정의는 그대로다.

## 4. 쿼리 이식

repository의 쿼리는 가능한 한 두 드라이버가 같은 SQL을 공유한다. 갈라지는 지점은 아래로 한정한다.

| 지점 | 규칙 |
| --- | --- |
| 플레이스홀더 | Postgres `$N`은 SQLite에서 동작하지 않는다(`?`만 된다). raw SQL은 `DialectPlaceholders`(`persistence/dialect-placeholders.ts`)의 `bind()`로 값을 바인딩한다. 값이 SQL에 나올 때마다 `bind()`를 한 번씩 호출하는 규칙 하나로 두 드라이버를 다룬다 |
| 배열 | 배열 타입에 의존하지 않는다. 재귀 쿼리의 경로는 텍스트와 구분자(`path \|\| '/' \|\| name`)로 누적하고 앱에서 `split`한다. 다건 삭제는 Postgres가 `ANY($1::uuid[])`, SQLite는 `IN (?,?,…)`이며 SQLite는 변수 개수 상한 때문에 `BLOB_DELETE_CHUNK_SIZE`(500) 단위로 나눈다 |
| 현재 시각 | `CURRENT_TIMESTAMP`(ANSI)를 쓴다. `now()`는 쓰지 않는다 |
| `Date` 바인딩 | SQLite는 `Date` 객체를 바인딩할 수 없다. `YYYY-MM-DD HH:MM:SS` 문자열(`T`·밀리초·`Z` 없음)로 바꿔 넘긴다. ISO 8601을 그대로 쓰면 구분자 차이(`T` vs 공백) 때문에 문자열 비교가 시각 순서와 어긋난다 |
| raw SQL의 timestamp 읽기 | SQLite는 `Date`가 아니라 공백 구분 문자열(`2026-09-08 23:02:01`)을 돌려준다. `new Date()`에 그대로 넘기면 V8이 로컬 타임존으로 해석해 컨테이너 타임존이 UTC가 아닐 때 시각이 조용히 틀어진다. raw 경로는 `T`·`Z`를 보정하는 `parseSqlTimestamp`를 거친다. TypeORM 엔티티 경로는 이 보정을 이미 한다 |
| `LIKE` 대소문자 | SQLite는 기본이 ASCII 대소문자 무시다. 연결 직후 `PRAGMA case_sensitive_like = ON`을 한 번 실행해 Postgres와 맞춘다(`persistence.module.ts`) |
| 재귀 CTE 상한 | Postgres는 바깥 `SELECT`의 `LIMIT`으로 CTE 평가가 멈춘다. SQLite는 재귀 항 안쪽 `LIMIT`이 있어야 큐 확장이 멈춘다. 상한이 필요한 재귀 쿼리는 위치를 드라이버별로 나눈다 |
| row lock | SQLite는 `setLock()`이 `LockNotSupportedOnGivenDriverError`를 던진다. `applyRowLockIfSupported`처럼 SQLite면 호출 자체를 건너뛴다. 단일 프로세스에서는 이벤트 루프와 `better-sqlite3`의 동기 실행이 쿼리 순서를 보장한다 |
| 트랜잭션 격리 | Postgres는 읽기 스냅샷에 `REPEATABLE READ`를 지정하고, SQLite는 기본 트랜잭션을 쓴다 |

새 raw SQL을 추가할 때는 위 표의 항목에 해당하는지 먼저 확인한다. 해당하지 않는 SQL은 분기 없이 공유한다.

## 5. 마이그레이션 실행 규칙 (SQLite)

- `queryRunner.query()`는 SQL 문 하나만 받는다. `better-sqlite3`가 멀티 스테이트먼트를 거부하므로 문장마다 호출을 나눈다.
- SQLite `DataSource`는 `migrationsTransactionMode: 'each'`를 쓴다. PostgreSQL은 기본값(`all`)을 유지한다.
- **테이블 재구성이 필요한 마이그레이션**(CHECK 제약 추가·변경. SQLite는 `ALTER TABLE ... ADD CONSTRAINT`가 없다)은
  `migrations/sqlite-table-rebuild.ts`의 `withSqliteTableRebuild`·`rebuildSqliteTable`을 쓴다.
  - `PRAGMA foreign_keys=OFF`는 트랜잭션 안에서 no-op이다. 그래서 TypeORM이 여는 자동 트랜잭션을 쓰지 않고 헬퍼가
    `PRAGMA` → 수동 `BEGIN`/`COMMIT`/`ROLLBACK` → `PRAGMA foreign_keys=ON`을 관리한다.
  - 이를 위해 마이그레이션 인스턴스의 `transaction` 속성을 `false`로 두어야 한다. 단 `all` 모드(Postgres)에서는
    `transaction`을 정의하면(`true`든 `false`든) `ForbiddenTransactionModeOverrideError`로 실패한다. 따라서 클래스 필드로
    대입하지 말고 **생성자에서 SQLite일 때만** 설정한다.
  - 현재 이 헬퍼를 쓰는 마이그레이션은 없다. 재구성이 필요한 변경이 생기면 이 규칙을 따른다.

## 6. GC 락

`GcLock`(PostgreSQL advisory lock과 `gc_state` 최소 실행 간격)이 막는 것은 여러 WAS 호스트가 하나의 DB를 공유하며 GC를
중복 실행하는 상황이다. SQLite는 단일 프로세스 전제라 이 문제가 없다.

- SQLite에서 `GcLock.tryAcquire`는 실제 잠금과 최소 실행 간격 판정 없이 항상 `true`를 반환하고, `markCompleted`와
  `release`는 아무것도 하지 않는다. 별도 구현체로 갈아 끼우지 않고 `GcLock` 클래스 안에서 `isSqlite`로 분기한다.
- `gc_state` 테이블은 PostgreSQL에만 만든다.
- GC 실행 빈도 제어는 SQLite 범위 밖이다.

## 7. 백업·복구

`BackupJob`·`RestoreJob`은 구체 도구가 아니라 `DbDumpTool`(`jobs/db-dump.tool.ts`) 인터페이스에 의존한다. 백업·복구
모듈이 `getDbDriver()`로 구현체를 골라 주입한다.

| | PostgreSQL (`PgDumpCliTool`) | SQLite (`SqliteDumpTool`) |
| --- | --- | --- |
| dump 파일 이름 | `postgres.dump` | `storix.sqlite` |
| 백업 | `pg_dump` 자식 프로세스 | `VACUUM INTO ?`(경로는 바인딩). 다른 연결이 읽기·쓰기 중이어도 일관된 스냅샷을 만든다. 외부 바이너리가 필요 없다 |
| 복구 | `pg_restore` 자식 프로세스 | 백업 파일을 `STORIX_DB_SQLITE_PATH`로 복사하고, 대상의 `-wal`·`-shm`·`-journal`을 지운다(새 메인 파일과 어긋나면 손상되므로) |

- 복구 가드(`BackupRepository.hasExistingNamespaces()`로 대상에 데이터가 있으면 강제 플래그 없이 거부)는 TypeORM 쿼리라
  드라이버와 무관하게 공유한다.
- `BackupResult`·`RestoreResult`의 필드는 드라이버와 무관하다. 갈라지는 것은 dump 파일 형식뿐이다.
- SQLite 복구는 `restore-main` 프로세스가 API와 별도로 돌며 대상 파일을 쓰는 다른 연결이 없다는 전제(6절과 같은
  단일 프로세스 전제)에서 성립한다.

## 8. 테스트 구조

- 같은 동작을 검증하는 테스트는 드라이버별로 따로 쓰지 않는다. 본문을 `*.shared-tests.ts`의 함수(예:
  `runBlobRepositorySharedTests`)로 두고, PostgreSQL용 `*.integration-spec.ts`와 SQLite용 `*.sqlite.integration-spec.ts`
  얇은 파일이 각각 호출한다. 독립된 두 spec은 서로 어긋난다.
- SQLite spec은 `:memory:` DB로 돌아 컨테이너가 필요 없다. `pnpm --filter @storix/api test:integration:sqlite`가
  `STORIX_DB_DRIVER=sqlite`를 얹은 별도 jest 실행으로 이 파일들만 고른다.
- **`STORIX_DB_DRIVER=sqlite`를 전체 `test:integration`에 전역으로 넣지 않는다.** 3.3의 상수가 프로세스당 한 번 고정되므로
  같은 워커에서 도는 Postgres 통합 테스트까지 `blob`·`datetime` 타입으로 열려 `DataTypeNotSupportedError`로 깨진다.
  `jest.integration.config.cjs`가 `STORIX_DB_DRIVER`가 `sqlite`가 아닐 때 `*.sqlite.integration-spec.ts`를 후보에서
  빼고, 각 SQLite spec은 `beforeAll`에서 환경변수가 없으면 즉시 에러를 던진다.
- 같은 프로세스 안에서 드라이버를 바꿔 가며 엔티티를 재사용하는 `describe.each` 방식은 3.3의 모듈 로드 시점 고정 때문에
  불가능하다.
- PostgreSQL 전용 기능(advisory lock, `pg_dump`)의 테스트는 PostgreSQL 전용으로 남는다.

## 9. 새 드라이버를 추가할 때 손대는 지점

3절의 엔티티 컬럼 상수, 3.1의 마이그레이션 분기, 4절의 방언 차이 표, 6·7절의 GC 락과 `DbDumpTool` 구현, 8절의 spec 분리다.
드라이버 판정 함수(`getDbDriver`, `isSqliteDataSource`)는 `postgres`·`sqlite` 이분법이라 함께 고쳐야 한다.
