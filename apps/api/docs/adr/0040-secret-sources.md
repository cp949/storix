# 비밀값을 `_FILE`·`_REF`로 받고 해석값은 `process.env`에 쓴다

## 상태

승인됨 (2026-10-04)

## 배경

- 첫 사용처는 개인정보 파일을 다루는 단일 호스트 배포다.
- 이 배포에서 비밀값은 환경변수로만 전달되었다.
- 환경변수는 다음 경로로 노출된다.
  - `docker inspect`의 `Config.Env`.
  - compose `.env` 보간으로 다른 서비스에 전달되는 값.
  - 컨테이너 프로세스의 `/proc/<pid>/environ`.
- 보호 우선순위는 통신, 파일, 환경변수 순이다.
- Storix는 범용 제품이다. 특정 클라우드나 비밀 저장소에 종속되지 않는다.
- 비밀값은 기동 시 한 번 읽는다. 값을 바꾸면 재시작한다(api ADR-0007).
- 환경변수만 쓰는 기존 배포는 변경 없이 기동해야 한다.

## 결정

1. 비밀 변수 `X`마다 값을 주는 방법을 셋 중 하나로 고른다.
   - `X=값`: 환경변수. 기존 동작이다.
   - `X_FILE=경로`: 파일.
   - `X_REF=<scheme>://<참조>`: 통신. `scheme`이 어댑터를 고른다.
2. 변수 단위로 지정한다.
   - 빈 문자열은 지정하지 않은 것으로 본다. 세 이름 모두 같다.
   - 빈 값이 아닌 항목이 둘 이상이면 기동을 실패시킨다.
   - `bootstrapWithEnv()` 경로에서는 `.env`에서 온 값도 포함한다. `typeorm` CLI 경로는 `.env`를 읽지 않는다.
   - 파일 값은 끝의 줄바꿈 하나(`\n` 또는 `\r\n`)만 제거한다.
   - 대상은 10개다: `SECRET_ENV_NAMES`(`apps/api/src/secrets/secret-source.ts`)가 원천이다.
3. 해석은 진입점 두 곳에서 같은 `resolveSecrets()`로 한다.
   - `bootstrapWithEnv()`: `.env`를 로드한 뒤 루트 모듈을 `import()`하기 전이다. `app`, `gc`, `backup`, `restore`가 거친다.
   - `persistence/data-source.ts`의 최상위 `await`: `typeorm` CLI 경로(`migrate`, `migration:run`, `migration:generate`)다.
   - 소비자 7곳은 수정하지 않는다.
4. 해석값을 `process.env[X]`에 쓴다.
   - 소비자는 `ConfigService`와 `process.env`로 읽는다. 루트 모듈 `import()` 전에 쓴 값을 그대로 읽는다.
   - `X_FILE`·`X_REF` 변수는 지우지 않는다. 경로와 참조는 비밀이 아니다.
5. 통신형은 어댑터 모듈로 확장한다.
   - 코어는 `file`만 내장한다. 제공자 SDK를 넣지 않는다.
   - 어댑터 기본 export가 `SecretSource`(`scheme`, `resolve(ref, { signal })`)다.
   - 로드할 패키지는 `STORIX_SECRET_ADAPTERS`에 쉼표로 지정한다.
   - 지정자는 bare 패키지 이름만 허용한다. 경로, URL, `node:` 접두 형식은 거부한다.
   - 코어는 `X_REF` 값 전체(`<scheme>://<참조>`)를 어댑터에 넘긴다.
   - 해석 1건의 타임아웃은 `STORIX_SECRET_RESOLVE_TIMEOUT_MS`(기본 10000)다. 코어는 재시도하지 않는다.
   - 기본 이미지에는 어댑터가 없다. 어댑터는 사용자 이미지에 설치한다.
6. `pg_dump`·`pg_restore` 자식 환경변수를 허용 목록으로 제한한다.
   - 넘기는 값은 `PATH`, `HOME`, `TZ`, `LANG`, `LC_*`, `PG*`다. `PGPASSWORD`는 코드가 설정한 값으로 덮어쓴다.
   - 그 밖의 변수는 넘기지 않는다.
7. compose 기본 파일의 `STORIX_API_KEY` 필수 마커 `${STORIX_API_KEY:?...}`를 `${STORIX_API_KEY:-}`로 완화한다.
   - compose는 `:?` 마커를 override 병합 전에 파일 전체에 평가한다. `STORIX_API_KEY_FILE`만 주는 배포가 compose 단계에서 실패한다.
   - 미설정 검증은 `app` 기동 시점의 `auth.module`이 한다.
8. `single-host-private` 시나리오에 파일 방식 override를 둔다.
   - `compose.secrets.yml`은 `STORIX_API_KEY`와 `STORIX_ENCRYPTION_MASTER_KEY`를 compose secret 파일로 전달한다.
   - `compose.secrets-postgres.yml`은 Postgres 비밀번호를 postgres와 Storix 서비스에 전달한다.

## 위협 모델

| 노출 경로                                      | 환경변수          | 파일(`_FILE`)       | 통신(`_REF`)      |
| ---------------------------------------------- | ----------------- | ------------------- | ----------------- |
| `docker inspect`의 `Config.Env`                | 노출              | 차단(컨테이너 실측) | 차단(미실측)      |
| compose `.env` 보간으로 다른 서비스에 전달     | 노출              | 차단(구성상)        | 차단(구성상)      |
| 컨테이너 프로세스의 `/proc/<pid>/environ`      | 노출              | 차단(컨테이너 실측) | 차단(미실측)      |
| 호스트 디스크의 평문 사본                      | `.env` 파일       | 비밀 파일           | 없음              |
| `pg_dump`·`pg_restore` 자식 환경 상속          | 차단(단위 테스트) | 차단(단위 테스트)   | 차단(단위 테스트) |
| 같은 프로세스 권한의 메모리·`process.env` 읽기 | 노출              | 노출                | 노출              |

- "차단(구성상)"은 값이 그 경로에 들어가지 않는 구성이라는 뜻이다. 그 경로를 따로 측정하지는 않았다.
- "차단(미실측)"은 통신 방식의 해석값이 파일 방식과 같은 방식으로 `process.env`에 쓰이므로 같다고 보는 추정이다.
  - 실제 어댑터로 컨테이너를 기동해 확인하지 않았다.
- "차단(단위 테스트)"는 `buildPgChildEnv`가 허용 목록 밖 변수를 넘기지 않는다는 단위 테스트 결과다.
  - 컨테이너 안 자식 프로세스의 실제 환경은 측정하지 않았다(미실측).
- 파일 방식의 비밀 파일도 호스트의 평문이다. 이득은 파일 단위 권한과 위 표의 차단 경로다.
- 같은 프로세스 권한의 읽기는 이 결정으로 막지 않는다.
- 코드가 자식 프로세스를 실행하는 곳은 `jobs/pg-dump-cli.tool.ts`의 `spawn` 한 곳이다.

## 실측

- 호스트 Node v24.20.0에서 `process.env`에 대입한 값(2026-10-04):
  - `/proc/<pid>/environ`에 나타나지 않았다.
  - `spawn`한 자식 프로세스는 대입 값을 상속했다.
- `single-host-private` 시나리오 컨테이너(Postgres 조합, VersityGW v1.8.0):
  - `app` 컨테이너의 `Config.Env`에 `STORIX_API_KEY`, `STORIX_ENCRYPTION_MASTER_KEY`, `STORIX_DB_PASSWORD`의 비밀값이 없었다.
  - `app` 프로세스와 exec 셸의 `/proc/*/environ`에도 없었다.
  - 검사가 비어 있지 않다는 대조로 `/proc` environ에서 세 변수의 `_FILE=` 줄 6개(프로세스 2개 × 3개)를 확인했다.
  - compose가 override 파일들의 `secrets:` 목록을 병합했다. `app`에 비밀 3개가 모두 있었다.
  - postgres 공식 이미지가 0444 비밀 파일을 `POSTGRES_PASSWORD_FILE`로 읽었다. 같은 파일로 `migrate`와 `app`이 접속했다.
  - 호스트 디렉터리의 0700 권한은 컨테이너 안에 적용되지 않았다. `/run/secrets`의 파일은 `-r--r--r--`였다.
  - 키 없이 호출하면 401이었다. 파일 키로 호출하면 400이었다. 이 결과는 인증을 통과했다는 사실만 보인다. 200 경로는 확인하지 않았다.
  - `backup` 서비스가 종료 코드 0으로 끝났다.
- 어댑터 로더:
  - 가짜 어댑터를 주입하는 계약 테스트(`apps/api/test/secrets/secret-adapter-loader.spec.ts`, `resolve-secrets.spec.ts`)로 검증했다.
  - 빌드한 dist를 실제 Node(Jest 밖)에서 실행했을 때, 설치되지 않은 패키지는 `not-found`로 실패했다.
  - 사용자 이미지에 설치한 실제 어댑터 패키지가 `apps/api` 위치 기준으로 해석되는지는 확인하지 않았다.
- VersityGW v1.8.0의 최상위 `--help`에는 파일 기반 자격증명 옵션이 없었다. 하위 명령 도움말은 확인하지 않았다.
  - root 자격증명 옵션은 `--access`·`--secret`(환경변수 `ROOT_ACCESS_KEY_ID`·`ROOT_SECRET_ACCESS_KEY`)로 보였다.

## Considered Options

- **전용 저장소 객체로 소비자를 바꾸는 안**:
  - 비밀값을 `process.env` 대신 전용 객체에 두고 소비자가 그 객체에서 읽는다.
  - 소비자 7곳과 `ConfigService` 경로를 모두 바꿔야 한다.
  - 같은 프로세스 권한 읽기는 이 안으로도 막지 못한다.
  - 보류한다.
- **에이전트·사이드카가 tmpfs 파일에 쓰고 `_FILE`로 읽는 안**:
  - 어댑터 없이 통신 전달을 얻는다.
  - 코어는 `_FILE` 지원 외에 바꿀 것이 없다.
  - 이 안은 어댑터와 함께 운영자가 고른다. 코어 결정과 충돌하지 않는다.
- **`migrate-main.ts` 진입점으로 `migrate`를 옮기는 안**:
  - `typeorm` CLI가 `data-source.ts`를 직접 여는 경로를 `bootstrapWithEnv()`를 거치게 바꾼다.
  - 배포 명령과 CLI 동작이 바뀐다.
  - 기각한다.
- **`pg_dump` 환경을 차단 목록(`STORIX_*` 제거)으로 만드는 안**:
  - 어댑터가 쓰는 자격증명 변수의 이름을 코어가 모른다.
  - 어댑터 자격증명을 막지 못한다.
  - 기각한다.

## Consequences

- 같은 프로세스 권한의 읽기는 막지 않는다. 해석값이 `process.env`에 있다.
- `pg_dump`·`pg_restore`는 허용 목록 밖 이름의 변수를 받지 않는다.
  - 운영자가 `PG*` 외의 이름(`SSL_CERT_FILE`, `LD_LIBRARY_PATH` 등)으로 libpq를 설정했다면 그 값이 자식에 전달되지 않는다.
  - 이런 운영 환경은 `PG*` 변수나 허용 목록 변경으로 옮긴다. 이런 환경이 실제로 있는지는 확인하지 않았다.
- `data-source.ts`의 최상위 `await`는 `typeorm` CLI가 데이터 소스 파일을 ESM `import()`로 여는 동작에 의존한다.
  - 통합 테스트 `migration-secret-source.integration-spec.ts`가 이 동작을 고정한다.
- `STORIX_API_KEY` 미설정 검출 시점이 바뀐다.
  - 이전: `docker compose` 단계에서 거부한다.
  - 이후: `app` 기동 시점에 거부한다. 메시지는 기존 `auth.module`의 것이다.
  - `migrate`는 이 값을 쓰지 않는다.
- VersityGW는 이 override로 비밀값을 파일로 받지 못한다.
  - v1.8.0 최상위 `--help` 범위에서 파일 기반 자격증명 옵션이 없었다. 하위 명령 도움말은 확인하지 않았다.
  - 따라서 VersityGW root 자격증명으로도 쓰이는 `STORIX_STORAGE_ACCESS_KEY`·`STORIX_STORAGE_SECRET_KEY`는 환경변수로 남는다.
  - 이 두 값은 `Config.Env`에 있었다.
- 통신형 어댑터를 쓰면 저장소 장애 시 Storix가 기동하지 못한다.
- 실제 제공자 어댑터는 이 결정에 포함하지 않는다.
- 어댑터 내부의 로그는 코어가 통제하지 못한다.
