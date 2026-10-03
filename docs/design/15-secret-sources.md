# 비밀값 소스

결정과 대안은 api ADR-0040이다. 이 문서는 그 결정이 만든 규약·해석 규칙·실패 정책·어댑터 계약을 쓴다.

## 설정 규약

비밀 변수 `X`마다 값을 주는 방법은 셋 중 하나다.

| 방식     | 지정                      | 예                                         |
| -------- | ------------------------- | ------------------------------------------ |
| 환경변수 | `X=값`                    | `STORIX_API_KEY=...`                       |
| 파일     | `X_FILE=경로`             | `STORIX_API_KEY_FILE=/run/secrets/api_key` |
| 통신     | `X_REF=<scheme>://<참조>` | `scheme`이 어댑터를 고른다                 |

- 변수 단위로 지정한다. 변수마다 다른 방식을 쓸 수 있다.
- 빈 문자열은 지정하지 않은 것으로 본다. `X`, `X_FILE`, `X_REF` 모두 같다.
- 빈 값이 아닌 항목이 둘 이상이면 기동을 실패시킨다.
- `bootstrapWithEnv()` 경로에서는 `.env`에서 온 값도 포함한다. `typeorm` CLI 경로는 `.env`를 읽지 않는다.
- `X_FILE`·`X_REF`·`STORIX_SECRET_*`는 모두 선택이다. 아무것도 지정하지 않으면 환경변수 `X`만 쓴다.
- 새 이름은 `STORIX_` 접두어를 유지한다(ADR-0005).
- `_FILE` 접미어는 Docker 공식 이미지 관례(`POSTGRES_PASSWORD_FILE`)와 같다.

대상 변수는 상수 `SECRET_ENV_NAMES`(`apps/api/src/secrets/secret-source.ts`)가 원천이다.

- `STORIX_API_KEY`, `STORIX_API_KEY_PREVIOUS`
- `STORIX_ADMIN_API_KEY`, `STORIX_ADMIN_API_KEY_PREVIOUS`
- `STORIX_ENCRYPTION_MASTER_KEY`
- `STORIX_STORAGE_ACCESS_KEY`, `STORIX_STORAGE_SECRET_KEY`
- `STORIX_DB_USERNAME`, `STORIX_DB_PASSWORD`
- `STORIX_SENTRY_DSN`

값은 기동 시 한 번 읽는다. 바꾸면 재시작한다(api ADR-0007).

## compose 전달 범위

기본 `docker-compose.yml`은 `environment:`에 적은 변수만 컨테이너에 넘긴다. 루트 `.env`는 compose 보간에만 쓰인다.

- `X_FILE`은 시나리오 override가 `environment:`에 직접 적는다.
- `X_REF`, `STORIX_SECRET_ADAPTERS`, `STORIX_SECRET_RESOLVE_TIMEOUT_MS`는 기본 compose가 넘기지 않는다.
  - 루트 `.env`에 적어도 컨테이너에 전달되지 않고, 오류 없이 무시된다.
  - 통신형은 사용자 이미지와 override의 `environment:`에서 지정한다.

## 해석 위치

진입점 두 곳이 같은 `resolveSecrets()`(`apps/api/src/secrets/resolve-secrets.ts`)를 호출한다.

`bootstrapWithEnv()`(`common/bootstrap-with-env.ts`). `app`, `gc`, `backup`, `restore`가 거친다.

1. `loadEnvFile()`로 `.env`를 로드한다.
2. `resolveSecrets()`가 비밀 변수를 해석해 `process.env`에 채운다. `.env`에 적은 `X_FILE`도 해석된다.
3. 루트 모듈을 `import()`한다.

`persistence/data-source.ts`. `typeorm` CLI 경로(`migrate`, `migration:run`, `migration:generate`)다.

- 최상위 `await resolveSecrets()` 뒤에 `new DataSource(...)`를 만든다.
- CLI는 `.env`를 읽지 않는다. 이 파일도 `loadEnvFile()`을 호출하지 않는다.
- 이 경로에서는 `.env`에 적은 `X_FILE`이 해석되지 않는다. 셸·컨테이너 환경변수만 해석한다.
- CLI가 데이터 소스 파일을 ESM `import()`로 연다. 최상위 `await`는 이 동작에 의존한다.

공통:

- 소비자(`ConfigService.get*`, `process.env`)는 수정하지 않는다.
- 해석값은 `process.env`에 쓴다. 소비자는 루트 모듈 `import()` 전에 쓴 값을 그대로 읽는다.

두 위치에는 제약이 있다.

- 앱 런타임은 `data-source.ts`를 import하면 안 된다.
  - 해석값 `X`와 `X_FILE`이 같은 `process.env`에 남는다.
  - 해석을 두 번 호출하면 두 번째 호출이 `env+file` `conflict`로 실패한다.
  - 해석 호출 위치는 진입점마다 한 번이다.
- `data-source.ts`의 엔티티 정적 import는 최상위 `await`보다 먼저 평가된다.
  - 엔티티가 읽는 `STORIX_DB_DRIVER`는 비밀값이 아니라서 현재는 충돌하지 않는다.
  - 엔티티가 비밀 환경변수를 읽게 되면 해석 전에 값을 읽는다.

## 해석 규칙

- 지정된 대상 변수를 병렬로 해석한다.
- 파일 값은 UTF-8로 읽고 끝의 줄바꿈 하나(`\n` 또는 `\r\n`)만 제거한다. 그 밖의 공백은 보존한다.
- 해석한 값이 빈 문자열이면 `empty`로 실패한다.
- 모든 변수가 성공했을 때만 `process.env[X]`에 쓴다. 실패가 하나라도 있으면 `process.env`를 바꾸지 않는다.
- `X_FILE`·`X_REF`는 지우지 않는다. 경로와 참조는 비밀이 아니다.
- `X_REF`는 `<scheme>://<참조>` 형식이어야 한다. `//` 뒤에 한 글자 이상 있어야 한다.
- 어댑터에는 `X_REF` 값 전체를 넘긴다.
- 값의 형식 검증은 기존 소비자가 한다. 예를 들어 마스터 키는 `master-key.ts`가 hex 64자를 검증한다.
- 필수 여부는 기존 소비자의 규칙을 따른다. 해석 단계는 필수 여부를 판단하지 않는다. 지정된 참조를 해석하지 못하면 실패시킨다.

## 실패 정책

해석에 실패한 변수가 하나라도 있으면 기동을 실패시킨다(종료 코드 1).

- `bootstrapWithEnv()` 경로: 각 진입점의 기존 `catch`가 로그를 남기고 종료 코드 1로 끝낸다.
- `data-source.ts` 경로: `typeorm` CLI가 import 오류를 `Unable to open file: ...`로 감싸 출력하고 종료 코드 1로 끝낸다.

공통 규칙:

- 실패한 변수를 모두 모아 한 번에 보고한다.
- 오류 메시지에는 변수명, 방식(`file`, `ref`, scheme, 충돌 조합), 실패 종류만 쓴다.
- 오류 메시지에 값을 쓰지 않는다. 어댑터가 던진 오류의 메시지도 옮기지 않는다.
- `X_REF`의 `file` scheme은 실패다. 파일은 `X_FILE`로만 지정한다.
- 코어는 재시도하지 않는다. 어댑터가 타임아웃 안에서 재시도할 수 있다.

해석 실패 종류(`SecretResolutionError`). 메시지 형식은 `비밀값 해석 실패: <변수>(<방식>): <종류>`다.

| 종류              | 조건                                                         |
| ----------------- | ------------------------------------------------------------ |
| `conflict`        | 빈 값이 아닌 지정이 둘 이상이다. 방식은 `env+file`처럼 쓴다. |
| `empty`           | 해석한 값이 빈 문자열이다.                                   |
| `not-found`       | `X_FILE` 경로의 파일이 없다.                                 |
| `unreadable`      | `X_FILE` 파일을 읽지 못했다. 파일이 없는 경우는 제외한다.    |
| `invalid-ref`     | `X_REF`가 `<scheme>://<참조>` 형식이 아니다.                 |
| `reserved-scheme` | `X_REF`의 scheme이 `file`이다.                               |
| `unknown-scheme`  | 로드한 어댑터 중 그 scheme을 제공하는 것이 없다.             |
| `timeout`         | 어댑터가 해석 타임아웃 안에 끝나지 않았다.                   |
| `adapter-error`   | 어댑터가 거부했거나 문자열이 아닌 값을 돌려줬다.             |

어댑터 로드 실패(`SecretAdapterLoadError`)는 해석보다 먼저 일어난다. 두 실패는 함께 보고되지 않는다.

타임아웃:

- 통신형 해석 1건마다 적용한다. 기본값은 `DEFAULT_SECRET_RESOLVE_TIMEOUT_MS`(10000)다.
- `STORIX_SECRET_RESOLVE_TIMEOUT_MS`로 바꾼다.
- 타임아웃이 지나면 `signal`을 abort한다.
- 어댑터가 `signal`을 무시해도 코어는 그 시점에 `timeout`으로 처리한다.
- 어댑터의 늦은 거부는 미처리 거부가 되지 않는다.
- 이 값이 양의 정수가 아니면 `SecretResolutionError`가 아닌 일반 `Error`(`잘못된 정수 환경변수 값: ...`)가 나온다.
  - 값 검증은 어댑터를 불러오기 전에 한다.
  - 메시지에 이 설정값이 들어간다. 비밀값이 아니다.

## 어댑터 계약

```ts
export interface SecretSource {
  readonly scheme: string;
  resolve(ref: string, options: { signal: AbortSignal }): Promise<string>;
}
```

- 코어는 `file`만 내장한다. 제공자 SDK를 넣지 않는다.
- 어댑터는 모듈이다. 기본 export가 `SecretSource`다.
- 계약은 구조적 타입이다. 어댑터 패키지는 Storix 소스를 import하지 않는다.
- `scheme`은 `SECRET_SCHEME_PATTERN`(소문자 영문으로 시작하는 `[a-z0-9+.-]`)을 따른다.
- `resolve`는 `X_REF` 값 전체(`<scheme>://<참조>`)를 받는다. 비밀값을 문자열로 돌려준다.
- `signal`이 abort되면 작업을 멈추고 열어 둔 연결을 닫는다.
  - 닫지 않으면 `gc`·`backup`·`restore`가 해석 실패 뒤에도 종료되지 않을 수 있다. 이 세 진입점은 해석 실패 시 `process.exitCode`만 설정하고 프로세스를 강제로 끝내지 않는다.
- 코어는 어댑터가 돌려준 값을 그대로 쓴다. 파일 소스와 달리 끝의 줄바꿈을 제거하지 않는다.
  - 어댑터는 줄바꿈이 없는 값을 돌려준다.
- 어댑터의 저장소 접근 자격증명은 어댑터가 자기 표준 방식으로 얻는다. Storix 환경변수로 받지 않는다.
- 코어는 해석값을 로그에 남기지 않는다. 테스트로 고정한다.
- 어댑터 내부의 로그는 코어가 통제하지 못한다. 어댑터는 해석값과 참조의 비밀 부분을 로그에 쓰지 않는다.
- 기본 이미지에는 어댑터가 없다. 어댑터 설치는 사용자 이미지 빌드의 책임이다.
- 어댑터를 쓰면 저장소 장애 시 Storix가 기동하지 못한다. 가용성 요구가 높은 배포는 저장소 가용성을 함께 설계한다.

## 어댑터 로더

`loadSecretAdapters()`(`apps/api/src/secrets/secret-adapter-loader.ts`)가 `STORIX_SECRET_ADAPTERS`의 지정자를 순서대로 `import()`한다.

지정자 규칙:

- 쉼표로 구분한다. 항목 앞뒤 공백과 빈 항목은 버린다.
- 정규식 `BARE_PACKAGE_PATTERN`을 통과하는 bare 패키지 이름만 허용한다.
  - 소문자, 숫자, `.`, `_`, `-`로 이루어진다. 선택적으로 `@scope/` 접두가 붙는다.
  - 허용 예: `storix-secret-x`, `@org/storix-secret-x`.
  - 거부: 상대·절대 경로, `file:`·`data:`·`http(s):` 등 URL 형식, `node:` 접두 형식, `pkg/sub` 하위 경로, 대문자.
- 정규식은 형식만 검사한다. `fs` 같은 내장 모듈 이름은 형식상 통과한다.
  - 이 경우 기본 export가 `SecretSource` 구조가 아니라서 `invalid-export`로 실패한다.
- 해석 기준은 로더 파일이 있는 패키지(`apps/api`)의 `node_modules`다. Node ESM의 패키지 탐색 규칙을 따른다.

기본 export 검증은 `scheme` 형식과 `resolve` 함수 여부만 본다.

로드 실패 종류(`SecretAdapterLoadError`). 메시지 형식은 `비밀값 어댑터 로드 실패: <지정자>: <종류>`다. 실패를 모두 모아 한 번에 던진다. `import()` 오류 메시지는 옮기지 않는다.

| 종류                | 조건                                                           |
| ------------------- | -------------------------------------------------------------- |
| `invalid-specifier` | `BARE_PACKAGE_PATTERN`을 통과하지 못했다.                      |
| `not-found`         | 모듈을 찾지 못했다(`ERR_MODULE_NOT_FOUND`·`MODULE_NOT_FOUND`). |
| `import-failed`     | 그 밖의 `import()` 오류다.                                     |
| `invalid-export`    | 기본 export가 `SecretSource` 구조가 아니다.                    |
| `reserved-scheme`   | scheme이 `file`이다.                                           |
| `duplicate-scheme`  | 이미 로드한 어댑터와 scheme이 같다.                            |

위협 모델:

- `STORIX_SECRET_ADAPTERS`는 운영자가 제어하는 값으로 취급한다.
- 환경변수를 제어하는 주체는 이미 `NODE_OPTIONS`(`--import`, `--require`)로 코드를 실행할 수 있다. 로더는 새 권한 경계를 만들지 않는다.
- bare 이름 제한은 방어 심층화다. 이미지에 설치된 패키지만 로드되게 한다.
- 쓰기 가능한 볼륨(`/backups` 등)의 파일이나 `data:` URL이 로드되는 경로를 없앤다.

## 자식 프로세스 환경

해석값이 `process.env`에 있으므로 자식 프로세스가 상속할 수 있다.
코드가 자식 프로세스를 실행하는 곳은 `jobs/pg-dump-cli.tool.ts`의 `spawn` 한 곳이다. `pg_dump`와 `pg_restore`가 모두 이 경로를 쓴다.

`buildPgChildEnv()`가 자식 환경변수를 허용 목록으로 만든다.

| 이름         | 이유                                                                  |
| ------------ | --------------------------------------------------------------------- |
| `PATH`       | `spawn`의 실행 파일 탐색에 쓴다.                                      |
| `HOME`       | libpq가 `~/.pgpass`, `~/.postgresql/` 인증서를 찾는 기준이다.         |
| `TZ`         | 시간대 표시에 쓴다.                                                   |
| `LANG`       | 메시지 언어에 쓴다.                                                   |
| `LC_*`       | 메시지 언어와 지역 설정에 쓴다.                                       |
| `PG*`        | 운영자가 `PGSSLMODE`, `PGSSLROOTCERT` 등으로 libpq를 설정하는 경로다. |
| `PGPASSWORD` | 코드가 설정한 값으로 덮어쓴다.                                        |

- 그 밖의 변수는 넘기지 않는다. `STORIX_*`와 어댑터 자격증명 변수가 모두 빠진다.
- 차단 목록(`STORIX_*` 제거)을 쓰지 않는 이유는 어댑터 자격증명 변수의 이름을 코어가 모르기 때문이다.
- 허용 목록 밖 이름(`SSL_CERT_FILE`, `LD_LIBRARY_PATH` 등)으로 libpq를 설정한 환경은 그 값이 자식에 전달되지 않는다.
  - 이런 값은 `PG*` 변수로 옮기거나 허용 목록에 추가한다.

## 로그와 오류 보고

- 새로 생기는 오류 경로는 `SecretResolutionError`와 `SecretAdapterLoadError`의 메시지뿐이다. 두 메시지에는 값이 없다.
- 기존 소비자의 오류 메시지(`requireEnv`, `auth.module`, `master-key.ts`)는 변수명만 쓴다.
- `PgDumpCliTool`의 실패 메시지는 `pg_dump`·`pg_restore`의 stderr를 포함한다. libpq가 비밀번호를 stderr에 쓰는지는 확인하지 않았다.

## 한계

- 비밀값은 프로세스 환경에 존재한다. 같은 프로세스 권한으로 읽힌다.
- 같은 프로세스 권한의 메모리·`process.env` 읽기는 이 설계로 막지 않는다.
- 실행 중 비밀값 교체는 지원하지 않는다.
- 마스터 키 로테이션과 envelope 암호화는 지원하지 않는다(api ADR-0009).
- 함께 띄우는 백엔드 컨테이너(Postgres, VersityGW)의 비밀값 전달은 코어 범위 밖이다. 시나리오 문서가 안내한다.
- 첫 실제 통신형 어댑터는 포함하지 않는다.

## 검증

단위 테스트(`apps/api/test`):

- `secrets/resolve-secret-values.spec.ts`: 충돌, 빈 값, 파일 오류, 줄바꿈 제거, scheme 오류, 메시지에 값이 없음, 실패 시 `process.env` 무변경, `signal`을 무시하는 어댑터의 타임아웃.
- `secrets/secret-adapter-loader.spec.ts`: 지정자 거부(경로, URL, `node:` 접두, 하위 경로, 대문자), 로드 실패 종류, scheme 충돌.
- `secrets/resolve-secrets.spec.ts`: 가짜 어댑터 주입, 타임아웃 설정, 해석 중 콘솔·표준 출력 무기록.
- `common/bootstrap-with-env.spec.ts`: `.env` 로드, 해석, 루트 모듈 `import()` 순서. 해석 실패 시 루트 모듈을 불러오지 않음.
- `jobs/pg-dump-cli.tool.spec.ts`: 자식 환경의 허용 목록.
- `common/env-docs.spec.ts`: README 표와 `.env.example`의 변수 이름 동기화.

통합 테스트(`apps/api/test`):

- `main-secret-source.integration-spec.ts`: `file` 소스로 `app`을 기동한다.
- `migration-secret-source.integration-spec.ts`: `typeorm` CLI가 `STORIX_DB_PASSWORD_FILE`로 마이그레이션을 적용한다. 해석 실패 시 0이 아닌 코드로 종료한다.
- `main-boot-env-file.integration-spec.ts`: 환경변수만 쓰는 기존 구성이 그대로 기동한다.

측정 근거(실측 환경 포함)는 api ADR-0040 "실측"에 있다.
