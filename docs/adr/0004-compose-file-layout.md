# compose base 파일은 백엔드 중립이며, 컨테이너 추가는 백엔드·DB별 override 파일로만 한다

## 상태

승인됨 (2026-09-08)

구현 완료.

## 배경

ADR-0003 이전의 루트 `docker-compose.yml`은 다음 구조였다.

- `postgres`와 스토리지 컨테이너를 profile 없이 항상 기동한다.
- `app`/`gc`/`backup`/`restore`의 `STORAGE_ENDPOINT`를 스토리지 컨테이너로 고정한다.
- 다음 override를 겹쳐 쓴다.
  - `docker-compose.versity-demo.yml`
  - `docker-compose.s3-demo.yml`
  - `docker-compose.shared-db.yml`

이 구조에는 다음 문제가 있었다.

- override를 적용해도 base의 `postgres`와 스토리지 컨테이너가 미사용 상태로 기동한다.
  - ADR-0003의 공유 DB 토폴로지와 맞지 않는다.
- base는 특정 백엔드를 기본으로 보이게 한다.
  - `-demo` 접미사는 VersityGW/S3를 지원 백엔드보다 시연용으로 보이게 한다.
- s3 override는 별도 `AWS_S3_*` 변수를 사용한다.
  - base의 `STORAGE_ACCESS_KEY`는 스토리지 컨테이너의 root 자격증명으로도 쓰인다.
- 같은 env 블록이 파일마다 서비스 4개에 반복된다.
- `PORT: 3000` 같은 따옴표 없는 정수 env 값은 podman-compose 1.6에서 파싱에 실패한다.
  - 같은 서비스의 `${PORT}` 치환에 int가 들어가 `''.join`이 실패한다.
  - DEPLOY-05의 Docker/Podman 공통 동작 전제를 충족하지 못한다.

## 결정

1. **base(`docker-compose.yml`)는 Storix 서비스만 정의한다.**
   - 대상은 `app`/`migrate`/`gc`/`backup`/`restore`다.
   - Postgres·스토리지 컨테이너는 포함하지 않는다.
   - DB·스토리지 접속 정보는 `.env`의 `DB_*`/`STORAGE_*`에서 읽는다.
   - base 단독 기동은 운영 중인 외부 DB와 외부 S3 호환 스토리지에 연결한다.
2. **컨테이너 추가·연결 재정의는 `docker-compose.<대상>.yml` override에서 한다.**
   - `docker-compose.versitygw.yml`
     - VersityGW 컨테이너와 버킷 초기화를 정의한다.
     - 서비스 4개의 `STORAGE_ENDPOINT/PORT/USE_SSL`을 재정의한다.
     - 목표 기본 백엔드다(ADR-0003).
   - `docker-compose.s3.yml`
     - 컨테이너를 추가하지 않는다.
     - 엔드포인트/443/SSL/path-style/`STORAGE_PUBLIC_*`를 AWS 값으로 고정한다.
     - 자격증명·리전·버킷은 `.env`의 `STORAGE_*`를 쓴다.
     - root 자격증명을 받는 컨테이너가 없어 `AWS_S3_*`를 제거한다.
   - `docker-compose.postgres.yml`
     - 개발·검증용 Postgres 컨테이너를 정의한다.
     - 서비스 5개의 `DB_HOST/DB_PORT`를 `postgres:5432`로 재정의한다.
     - 호스트에 `127.0.0.1:${DB_PORT}`로 노출한다.
   - 백엔드 파일은 동급이며 서로 우선하지 않는다.
   - 파일 목록에 지원 백엔드가 드러나도록 `-demo` 접미사를 쓰지 않는다.
3. **Storix 구성 요소가 아닌 compose 파일은 루트 밖에 둔다.**
   - 루트에는 base, 백엔드 2종, 개발 DB 파일만 둔다.
   - CI 전용 override는 `.github/compose.ci.yml`에 둔다.
     - `.github/workflows/` 안에 두면 GitHub이 워크플로로 파싱한다.
   - nginx reverse-proxy 샘플(STORAGE-03)은 `docs/deployment/compose.nginx-demo.yml`에 둔다.
     - 마운트할 conf 파일 옆에 배치한다.
     - TLS 종료 프록시 뒤의 presigned URL을 검증하는 개발 도구다.
     - Storix 필수 구성은 아니다.
     - 파일 지정으로 사용 여부를 선택하므로 profile은 쓰지 않는다.
4. **파일 안 중복은 YAML 앵커(`x-*` + `&`/`*`/`<<:`)로 제거한다.**
   - base는 `x-db-env`/`x-storage-env`/`x-api-build`를 재사용한다.
   - override는 `x-<대상>-env`/`x-<대상>-deps`를 재사용한다.
   - 재사용 대상은 서비스 4~5개다.
   - compose-spec 표준이다.
   - docker compose(yaml.v3)와 podman-compose(PyYAML)가 지원한다.
5. **base·백엔드 override에는 `${VAR:?}` 필수 마커를 쓰지 않는다.**
   - 필수 마커는 profile 필터링·override 병합 전에 파일 전체에서 평가된다.
   - override가 값을 채우는 조합도 차단한다.
   - 미설정 검증은 app 부팅 시 `requireEnv`와 `ConfigService.getOrThrow`에 맡긴다.
   - 모든 조합에서 외부 입력이 필요한 `API_KEY`만 예외로 둔다.
6. **`environment`의 숫자 리터럴은 따옴표로 감싼다.**
   - 예: `PORT: '3000'`, `STORAGE_PORT: '7070'`.
   - Docker Compose는 이 값을 문자열로 전달한다.
   - 따옴표는 podman-compose의 int 치환 결함을 피한다.
7. **`docker-compose.shared-db.yml`과 `SHARED_DB_HOST`는 제거한다.**
   - 외부 DB 연결은 base의 기본 동작이다.
   - `.env`의 `DB_HOST`/`DB_PORT`로 연결한다.
   - 비표준 공유 DB 포트도 `DB_PORT`로 지정한다.
8. **`-f` 나열을 줄이는 방법을 문서화한다.**
   - override를 `docker-compose.override.yml`로 복사한다.
     - gitignore 대상이다.
     - docker/podman 모두 자동 병합한다.
   - `.env`에 `COMPOSE_FILE`을 지정한다.
     - docker compose는 직접 읽는다.
     - podman-compose는 셸 export가 필요하다.

## Considered Options

- **단일 파일 + profile로 백엔드 선택**: 보류한다.
  - `app`이 비활성 profile 서비스에 의존하면 검증 오류가 난다.
  - profile에 따라 `STORAGE_ENDPOINT`를 바꿀 수 없다.
  - 파일 목록에서 지원 백엔드를 알 수 없다.
- **백엔드별 self-contained 파일**: 보류한다.
  - `app`/`gc`/`backup`/`restore` 정의가 복제된다.
  - env 하나를 바꿀 때도 모든 파일을 고쳐야 한다.
- **compose `include:`**: 보류한다.
  - 포함된 파일의 서비스를 override하면 충돌 오류가 난다.
  - `STORAGE_ENDPOINT` 재정의와 `depends_on` 추가를 할 수 없다.
- **특정 백엔드를 base 기본으로 유지**: 보류한다.
  - VersityGW/S3를 시연용으로 보이게 하는 문제가 남는다.

## Consequences

- **breaking**: base 단독 `docker compose up`은 `postgres`와 스토리지 컨테이너를 기동하지 않는다.
  - 기존 로컬 개발 명령에는 다음 파일 옵션이 필요하다.
    ```sh
    docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml up
    ```
  - `SHARED_DB_HOST`/`AWS_S3_*` 변수를 제거한다.
- ADR-0003의 스택별 전용 Postgres 문제를 해결한다.
  - 멀티 인스턴스 절차는 `docs/deployment/multi-instance-versitygw.md`에 반영했다.
- nginx 샘플은 `versitygw:7070` upstream을 유지한다.
  - 위치는 `docs/deployment/compose.nginx-demo.yml`이다.
  - 개발·검증 도구이므로 백엔드 중립화는 계획하지 않는다.
- 로컬 검증은 podman-compose `config`로 병합 결과를 확인했다.
  - 검증 조합은 base 단독, +versitygw, +versitygw+postgres+ci, +versitygw+postgres+nginx 샘플, +s3다.
  - gc/backup/restore profile도 포함했다.
- 로컬 실기동은 podman-compose의 기본 네트워크 DNS 결함으로 수행하지 못했다.
  - `dev` push 시 `.github/workflows/versity-demo-smoke.yml`이 실제 Docker Compose로 검증한다.
- `.env`의 `COMPOSE_FILE` 동작은 compose-go의 옵션 적용 순서를 근거로 판단했다.
  - 순서는 `WithOsEnv` → `WithDotEnv` → `WithConfigFileEnv`다.
  - 로컬 환경에 docker가 없어 직접 검증하지 못했다.
