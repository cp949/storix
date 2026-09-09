# SQLite도 다른 백엔드 override와 같은 방식으로 compose 스택에 편입한다

## 상태

승인됨 (2026-09-09) — 구현 완료.

## 배경

SQLite 드라이버(`STORIX_DB_DRIVER=sqlite`, `README.sqlite.md`)는 Plan
B까지 host 직접 실행(`pnpm --filter @storix/api run backup:run:prod`
등, `.env` 로드)에서만 검증됐다. 루트 `docker-compose.yml`의
`x-db-env`가 Postgres 접속 정보(`STORIX_DB_HOST/PORT/USERNAME/PASSWORD/NAME`)만
컨테이너에 넘기고, `STORIX_DB_DRIVER`/`STORIX_DB_SQLITE_PATH`는 넘기지
않으며, 어떤 서비스에도 SQLite 파일용 볼륨이 없었기 때문이다. 그 결과
compose 기반 배포·개발(`docker compose up`)을 SQLite로는 할 수 없었다.
이 제약 자체는 `README.sqlite.md`에 정확히 문서화돼 있었지만
(ADR-0004가 정한 base/override 배치를 SQLite가 활용하지 못하는 상태),
근본 결함은 남아 있었다.

## 결정

1. **`docker-compose.sqlite.yml`을 ADR-0004가 정한 override 계열에
   추가한다.** 다른 백엔드/DB override(`versitygw.yml`/`minio.yml`/
   `s3.yml`/`postgres.yml`)와 동급으로 루트에 둔다.
2. **컨테이너를 추가하지 않는다.** SQLite는 별도 서버 프로세스가 없는
   파일 기반 DB이므로, `postgres.yml`처럼 컨테이너 서비스를 정의할
   필요가 없다. 대신 named volume `sqlite-data`를 만들고
   `migrate`/`app`/`gc`/`backup`/`restore` 5개 서비스 모두
   `/data`에 마운트해, `STORIX_DB_SQLITE_PATH=/data/storix.sqlite`로
   같은 파일을 공유하게 한다.
3. **backup/restore도 다른 3개 서비스와 동일하게 override 대상에
   포함한다.** `README.sqlite.md`가 이미 명시한 "단일 프로세스
   all-in-one 전제(동시에 겹쳐 돌지 않는다)"는 compose profile
   분리로 이미 충족된다 — `migrate`/`app`은 기본 `up`에서 돌고
   `gc`/`backup`/`restore`는 각각 별도 profile이라 `--profile`로
   명시해야만 실행된다. 이 경계를 넘는 보호(같은 SQLite 파일에 대해
   `gc`와 `restore`를 동시에 실행하는 등 운영자 실수)는 여전히
   운영자 책임이며, 이는 host 직접 실행에서도 동일했던 전제다.
4. **볼륨 병합은 compose의 표준 동작에 의존한다.** compose는 여러
   `-f` 파일의 서비스별 `volumes` 리스트를 마운트 지점(target path)
   기준으로 병합한다(완전 대체가 아니다). `backup`/`restore`는 base가
   이미 갖고 있는 `./backups:/backups`와 override가 추가하는
   `sqlite-data:/data`가 타겟 경로가 달라 충돌 없이 공존한다.
5. **멀티호스트 배포 미지원은 변하지 않는다.** 여러 WAS 호스트가 같은
   SQLite 파일을 공유하는 배포는 여전히 지원하지 않는다
   (`README.sqlite.md`) — docker-compose 자체가 단일 호스트 토폴로지고,
   이 override도 단일 호스트 안에서 5개 서비스가 named volume 하나를
   나눠 쓰는 구성이다.

## Considered Options

- **SQLite를 compose 스택에 편입하지 않고 host 직접 실행만 지원**: 이미
  검증된 상태를 유지하지만, compose 기반 배포/개발을 SQLite로도 하고
  싶다는 요구를 충족하지 못한다. 보류.
- **`gc`/`backup`/`restore`는 제외하고 `migrate`/`app`만 override
  대상으로 삼는다**: profile 분리로 이미 동시 실행이 방지되므로
  5개 전부를 포함해도 추가 위험이 없다고 판단해 보류.
- **bind mount로 호스트 디렉터리를 직접 노출**: named volume 쪽이
  `postgres.yml`의 `postgres-data`와 관례가 일치하고, 호스트 파일
  권한/경로 문제를 compose가 관리하게 둘 수 있어 채택.

## Consequences

- `docker compose -f docker-compose.yml -f docker-compose.sqlite.yml up
  -d`로 SQLite 기반 all-in-one 스택을 기동할 수 있다.
- `README.sqlite.md`의 "compose 스택이 SQLite를 지원하지 않는다"는
  제약 문장은 제거되고, override 사용법으로 교체됐다.
- 로컬 검증은 `docker compose ... config`로 병합 결과만 확인했다
  (ADR-0004가 이미 쓴 방식과 동일 — 로컬 podman-compose는 기본 네트워크
  DNS 결함으로 실기동이 불가능하다). CI를 통한 실기동 스모크 테스트
  확장은 이 ADR의 스코프 밖이며, 별도 후속 과제로 남는다.
