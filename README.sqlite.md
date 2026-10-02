# SQLite 드라이버

`STORIX_DB_DRIVER=sqlite`로 Postgres 없이 단일 파일 DB를 사용한다.
사용 대상:

- 소규모·단일 호스트 배포.
- 로컬 개발.
- CI 스모크 테스트.

## 배포 모델

**단일 프로세스 all-in-one 배포**를 전제로 한다.

- API·마이그레이션·gc·backup·restore는 같은 호스트에서 실행한다.
- 프로세스가 동시에 겹쳐 실행되지 않아야 한다.
- VFS snapshot 생성·복원·삭제는 **단일 프로세스·단일 writer** 순차 실행만 지원한다.
- 여러 SQLite 연결에서 snapshot을 동시에 변경하는 구성은 지원하지 않는다.
- 여러 WAS 호스트가 같은 SQLite 파일을 공유하는 배포는 지원하지 않는다.
- 멀티 인스턴스는 Postgres와 `README.versitygw.md`의 구성을 사용한다.

잠금 제약:

- GC advisory lock(`gc-lock.ts`)은 SQLite에서 no-op이다.
- 여러 인스턴스가 같은 SQLite 파일에 `gc`를 동시에 실행하면 레이스 컨디션이 발생한다.
- `.setLock('pessimistic_write')` 기반 row lock은 SQLite에서 생략한다.
- SQLite는 해당 row lock을 지원하지 않는다.
- 단일 프로세스에서는 Node 이벤트 루프와 better-sqlite3의 동기 실행으로 쿼리 순서를 보장한다.

compose 설정:

- base에 `docker-compose.sqlite.yml` override를 겹친다.
- 별도 DB 컨테이너는 추가하지 않는다.
- migrate·app·gc·backup·restore는 named volume `sqlite-data`의 `storix.sqlite` 파일을 공유한다.

```sh
docker compose -f docker-compose.yml -f docker-compose.sqlite.yml up -d
```

배치 결정은 `docs/adr/0022-sqlite-compose-override.md`를 따른다.

## 설정

```env
STORIX_DB_DRIVER=sqlite
STORIX_DB_SQLITE_PATH=/data/storix.sqlite
```

`STORIX_DB_DRIVER=sqlite`면 `STORIX_DB_HOST`/`STORIX_DB_PORT`/
`STORIX_DB_USERNAME`/`STORIX_DB_PASSWORD`/`STORIX_DB_NAME`은 무시된다.

## 백업/복구

Postgres의 `pg_dump`·`pg_restore` 대신 SQLite 내장 기능을 사용한다.

### 백업

compose 실행:

```bash
docker compose -f docker-compose.yml -f docker-compose.sqlite.yml --profile backup run --rm backup
```

호스트 실행(`.env` 로드 필요):

```bash
# 빌드 산출물 실행
pnpm --filter @cp949/storix-api run backup:run:prod
# 개발 중 실행
pnpm --filter @cp949/storix-api run backup:run
```

- `VACUUM INTO`는 DB 실행 중에도 일관된 스냅샷을 만든다.
- 스냅샷 파일은 `<백업 디렉터리>/storix.sqlite`다.
- 이 파일은 Postgres 백업의 `postgres.dump`를 대신한다.
- 스토리지 object 미러링은 드라이버와 관계없이 같은 절차를 쓴다.
- 상세 절차는 `docs/deployment/backup-restore.md`를 따른다.

불변 VFS snapshot 백업:

- SQLite DB와 Blob 버킷을 같은 시점에 확보한다.
- 백업 동안 API 쓰기와 GC를 멈춘다.
- DB 파일 복구만으로는 snapshot의 Blob 참조와 manifest를 함께 보존할 수 없다.
- snapshot 마이그레이션의 `down()`만 실행해도 함께 보존할 수 없다.

### 복구

compose 실행:

```bash
docker compose -f docker-compose.yml -f docker-compose.sqlite.yml --profile restore run --rm restore
```

호스트 실행(`.env` 로드 필요):

```bash
# 빌드 산출물 실행
pnpm --filter @cp949/storix-api run restore:run:prod
# 개발 중 실행
pnpm --filter @cp949/storix-api run restore:run
```

- 별도 restore 프로세스가 백업 파일을 `STORIX_DB_SQLITE_PATH`로 복사한다.
- API 프로세스가 해당 파일을 열지 않은 상태에서만 복구한다.
- 백업 형식은 `storix.sqlite`이며 Postgres의 `postgres.dump`와 다르다.
- SQLite와 Postgres 간 데이터 마이그레이션 도구는 없다.

## 알려진 제약

- 멀티프로세스/멀티호스트 SQLite 배포 미지원(위 배포 모델 참고).
- SQLite ↔ Postgres 간 데이터 마이그레이션 도구 없음.
- `findRecursive`의 이름 필터는 `PRAGMA case_sensitive_like=ON`으로
  Postgres와 동일하게 대소문자를 구분한다(연결 시점에 자동 적용).

## 검증

SQLite 전용 통합테스트:

```bash
pnpm --filter @cp949/storix-api run test:integration:sqlite
```

| 검증 대상                                   | 환경               |
| ------------------------------------------- | ------------------ |
| 마이그레이션 체인                           | 컨테이너 없음      |
| `BlobRepository`·`VfsNodeRepository` 스모크 | 컨테이너 없음      |
| `GcJob` 전체 왕복                           | VersityGW 컨테이너 |
| 백업·복구 왕복                              | VersityGW 컨테이너 |

`GcJob`·백업·복구 테스트는 object storage 검증에 VersityGW를 사용한다.
Postgres 통합테스트와 같은 방식이다.

compose 병합 확인:

```bash
docker compose -f docker-compose.yml -f docker-compose.sqlite.yml config
```

- 로컬 podman-compose의 기본 네트워크 DNS 결함으로 실제 기동은 검증하지 못했다.
- 결함 기록은 ADR-0004의 Consequences를 참고한다.
- 실제 기동은 Docker Compose가 있는 환경에서 검증한다.
