# SQLite 드라이버

`STORIX_DB_DRIVER=sqlite`로 Postgres 없이 단일 파일 DB로 Storix API를
부팅할 수 있다. 소규모/단일 호스트 배포, 로컬 개발, CI 스모크 테스트에
적합하다.

## 배포 모델

**단일 프로세스 all-in-one 전제**: API·마이그레이션·gc·backup·restore가
같은 호스트에서, 동시에 겹쳐 돌지 않는다는 가정 위에 설계돼 있다.

- 여러 WAS 호스트가 같은 SQLite 파일을 공유하는 멀티프로세스/멀티호스트
  배포는 지원하지 않는다(Postgres + `README.versitygw.md`의 멀티 인스턴스
  구성을 대신 쓴다).
- GC job의 advisory lock(`gc-lock.ts`)은 SQLite에서 no-op이다 — 멀티
  인스턴스 중복 실행 방지 자체가 단일 프로세스 전제에서는 불필요하기
  때문이다. 여러 인스턴스가 같은 SQLite 파일에 대해 `gc`를 동시에 실행하면
  안 된다(레이스 컨디션 발생).
- `.setLock('pessimistic_write')` 기반 row lock도 SQLite에서는 스킵된다
  (SQLite가 지원하지 않고, 단일 프로세스에서는 Node 이벤트 루프의
  단일 스레드성 + better-sqlite3의 동기 실행이 이미 쿼리 순서를
  보장하므로 불필요).
- `docker-compose.yml` 스택 자체는 `STORIX_DB_DRIVER=sqlite`를 지원하지
  않는다 — `x-db-env`가 Postgres 접속 정보만 컨테이너에 넘기고
  SQLite 파일용 볼륨 마운트도 없다. 이 스택은 Postgres 전용이며,
  SQLite는 호스트 직접 실행 또는 별도로 구성한 커스텀 컨테이너
  배포에서만 쓴다.

## 설정

```env
STORIX_DB_DRIVER=sqlite
STORIX_DB_SQLITE_PATH=/data/storix.sqlite
```

`STORIX_DB_DRIVER=sqlite`면 `STORIX_DB_HOST`/`STORIX_DB_PORT`/
`STORIX_DB_USERNAME`/`STORIX_DB_PASSWORD`/`STORIX_DB_NAME`은 무시된다.

## 백업/복구

Postgres의 `pg_dump`/`pg_restore` 대신 SQLite 내장 기능을 쓴다. `backup`/
`restore` docker-compose profile은 Postgres 전용이므로(위 배포 모델 참고)
SQLite는 호스트에서 `.env`를 로드한 상태로 직접 실행한다:

- **백업**: `pnpm --filter @storix/api run backup:run:prod`(빌드 산출물 실행)
  또는 개발 중에는 `backup:run`(빌드+실행). `VACUUM INTO`로 실행 중에도
  일관된 스냅샷을 원자적으로 `<백업 디렉터리>/storix.sqlite`에 만든다
  (Postgres 백업의 `postgres.dump` 자리를 대신함). MinIO object 미러링
  절차는 드라이버 무관 — `docs/deployment/backup-restore.md` 참고.
- **복구**: `pnpm --filter @storix/api run restore:run:prod`(또는
  `restore:run`). 백업 파일을 `STORIX_DB_SQLITE_PATH`로 복사한다. API
  프로세스가 그 파일을 열고 있지 않은 상태(별도 프로세스로 도는 restore
  job이 전제)에서만 안전하다.

백업 파일 형식은 Postgres와 다르다(`storix.sqlite` vs `postgres.dump`) —
드라이버를 바꾸는 마이그레이션 도구는 없다.

## 알려진 제약

- 멀티프로세스/멀티호스트 SQLite 배포 미지원(위 배포 모델 참고).
- SQLite ↔ Postgres 간 데이터 마이그레이션 도구 없음.
- `findRecursive`의 이름 필터는 `PRAGMA case_sensitive_like=ON`으로
  Postgres와 동일하게 대소문자를 구분한다(연결 시점에 자동 적용).

## 검증

- `pnpm --filter @storix/api run test:integration:sqlite` — SQLite 전용
  통합테스트(마이그레이션 체인, `BlobRepository`, `VfsNodeRepository`
  스모크, 백업/복구 왕복) 전부를 한 번에 실행한다. 마이그레이션·리포지토리
  테스트는 컨테이너 없이 빠르게 돌고, 백업/복구 왕복 테스트만 object
  storage 검증을 위해 MinIO 컨테이너를 띄운다(드라이버와 무관 — Postgres
  통합테스트와 동일한 방식).
