# SQLite도 다른 백엔드 override와 같은 방식으로 compose 스택에 편입한다

## 상태

승인됨 (2026-09-09)

구현 완료.

## 배경

이 결정 전의 SQLite 드라이버(`STORIX_DB_DRIVER=sqlite`)는 호스트 직접 실행에서만 검증됐다.
예를 들어 `.env`를 로드하고 `pnpm --filter @cp949/storix-api run backup:run:prod`를 실행했다.

당시 루트 `docker-compose.yml`에는 다음 제약이 있었다.

- `x-db-env`는 Postgres 접속 정보(`STORIX_DB_HOST/PORT/USERNAME/PASSWORD/NAME`)만 전달한다.
- `STORIX_DB_DRIVER`/`STORIX_DB_SQLITE_PATH`는 전달하지 않는다.
- SQLite 파일용 볼륨이 없다.

SQLite로 compose 기반 배포·개발(`docker compose up`)을 할 수 없었다.
이 제약은 `README.sqlite.md`에 명시돼 있었다.
SQLite에도 ADR-0004의 base/override 배치를 적용한다.

## 결정

1. **`docker-compose.sqlite.yml`을 루트 override 계열에 추가한다.**
   - ADR-0004의 배치 규칙을 따른다.
   - VersityGW/S3/Postgres override와 동급으로 둔다.
2. **SQLite용 컨테이너 서비스는 추가하지 않는다.**
   - SQLite는 별도 서버 프로세스가 없는 파일 기반 DB다.
   - named volume `sqlite-data`를 만든다.
   - `migrate`/`app`/`gc`/`backup`/`restore`에 `/data`로 마운트한다.
   - `STORIX_DB_SQLITE_PATH=/data/storix.sqlite`로 같은 파일을 공유한다.
3. **backup/restore도 override 대상에 포함한다.**
   - `README.sqlite.md`의 단일 프로세스 all-in-one 전제를 유지한다.
   - `migrate`/`app`은 기본 `up`에서 실행한다.
   - `gc`/`backup`/`restore`는 별도 profile로 기본 `up`에서 제외한다.
   - 각 profile은 `--profile`로 활성화한다.
   - profile은 동시 실행을 강제로 차단하지 않는다.
   - 같은 파일을 쓰는 `gc`와 `restore` 등의 동시 실행 방지는 운영자 책임이다.
   - 호스트 직접 실행에서도 같은 전제를 적용한다.
4. **볼륨은 compose 표준 병합을 사용한다.**
   - 여러 `-f` 파일의 서비스별 `volumes`는 마운트 지점(target path)으로 병합한다.
   - 리스트 전체를 대체하지 않는다.
   - base의 `./backups:/backups`와 override의 `sqlite-data:/data`는 마운트 지점이 다르다.
   - `backup`/`restore`에서 두 볼륨을 함께 사용한다.
5. **멀티호스트 배포는 지원하지 않는다.**
   - 여러 WAS 호스트가 같은 SQLite 파일을 공유할 수 없다(`README.sqlite.md`).
   - 이 override는 단일 호스트의 서비스 5개가 named volume 하나를 공유하는 구성이다.

## Considered Options

- **SQLite는 호스트 직접 실행만 지원**: 보류한다.
  - 기존 검증 범위를 유지한다.
  - SQLite 기반 compose 배포·개발 요구를 충족하지 못한다.
- **`migrate`/`app`만 override**: 보류한다.
  - 나머지 서비스는 profile로 기본 기동에서 제외할 수 있다.
  - 운영자가 동시 실행을 피한다는 전제로 전체 서비스를 포함한다.
- **호스트 디렉터리 bind mount**: 채택하지 않는다.
  - 대신 named volume을 채택한다.
  - Postgres override의 `postgres-data`와 관례를 맞춘다.
  - 호스트 파일 권한·경로 관리를 compose에 맡긴다.

## Consequences

- SQLite 기반 all-in-one 스택은 다음 명령으로 기동한다.

  ```sh
  docker compose -f docker-compose.yml -f docker-compose.sqlite.yml up -d
  ```

- `README.sqlite.md`의 compose 미지원 설명을 override 사용법으로 교체했다.
- 당시 로컬 검증은 `docker compose ... config`로 병합 결과만 확인했다.
  - ADR-0004와 같은 검증 범위다.
  - 로컬 podman-compose의 기본 네트워크 DNS 결함으로 실기동하지 못했다.
- CI 실기동 스모크 테스트 확장은 별도 후속 과제다.
  - 이 ADR의 범위에는 포함하지 않는다.
