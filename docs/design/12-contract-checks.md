# 계약 검증(contract)

## 목적

`apps/contract`는 소비자가 공개 HTTP API에 기대하는 동작을 실제 서버에 실행해 보장한다. 결정 배경은 `docs/adr/0029-contract-checks.md`다.

## 구성

- `src/define-contract.ts`: 계약 정의 API와 컨텍스트 타입.
- `src/contracts/<영역>/<id>.ts`: 계약 파일. 하나에 계약 하나다.
- `src/runner/`: 서버·DB·blob 기동, 계약 발견·검증·실행.
- `src/client/api-client.ts`: 계약이 쓰는 HTTP 클라이언트.
- `src/cli.ts`: `pnpm contract`의 진입점.

## 계약 정의

- `defineContract({ id, title, rq, profile?, run })`이 입력을 검증한다.
- `id`는 소문자 kebab-case이고 전체에서 유일하다.
- `rq`는 필수이고 각 값은 `docs/requirements/file-storage.md`에 있는 `RQ-NNN`이다.
- `skip`·`only` 옵션은 없다. 알 수 없는 옵션은 오류다.
- 계약 파일은 `default export`로 계약을 내보낸다. 파일을 추가하면 실행 대상이 된다.
- `run(ctx)`는 `node:assert/strict`로 검증하고 위반 시 throw한다.
- `ctx`는 `baseUrl`, `apiKey`, `adminKey`(관리자 API 호출용, 서비스 key로는 인증되지 않는다), `client`(공개 HTTP 클라이언트), `createNamespace(options?)`, `server.restart()`, `blobStorage`(`stop()`·`start()`·`deleteAllObjects()`)를 제공한다. 프로필이 capability를 허용하면 `createNamespace()`는 그 capability가 켜진 namespace를 주고, `withoutCapabilities: true`를 주면 허용되지 않은 새 namespace를 API로 만든다. `server.restart()`는 같은 포트·env·DB로 서버를 다시 띄우며, 재시작 뒤 지속성·멱등성 재생을 검증하는 계약만 쓴다. `blobStorage`는 VersityGW 컨테이너를 멈추거나 되살리고 버킷 객체를 지우며 저장 장애 계약(`contracts/storage/`)만 쓴다. `deleteAllObjects()`는 버킷 전체를 지우므로 계약은 자기 namespace의 파일만 다루고 앞 계약이 만든 파일에 기대지 않는다. 컨테이너는 고정 호스트 포트로 띄운다(`docker stop` 뒤 `start`에서 임의 포트는 바뀐다). 러너는 계약이 끝날 때마다 멈춘 저장소를 되살리므로 실패한 계약이 뒤 계약을 막지 않는다.

## 작성 규약

- 계약은 `apps/api` 소스를 import하지 않는다. `apps/contract`는 `@cp949/storix-api`에 의존하지 않는다.
- 계약끼리 의존하지 않는다. 계약은 `ctx.createNamespace()`로 받은 자기 namespace만 쓴다.
- 정리 코드를 쓰지 않는다. 서버 종료가 정리한다.
- 시간 대기에 `sleep`을 쓰지 않는다.
- 파일 머리 주석에 소비자 기대 한 문장과 대응 RQ를 쓴다.

## 실행 흐름

1. 계약을 발견하고 `id` 중복과 문서에 없는 RQ를 검사한다. 위반이면 서버를 기동하지 않고 종료 코드 1로 끝난다.
2. VersityGW 컨테이너를 한 번 기동하고 버킷을 만든다. 시작할 때 이전 실행이 남긴 `storix-contract-` 컨테이너를 제거한다.
3. 프로필별로 그룹화한다. 그룹마다 새 SQLite 파일에 migration을 적용하고 API 서버를 한 번 기동한다.
4. 계약을 순차 실행한다. 한 계약의 실패는 다음 계약 실행을 막지 않는다.
5. 실패가 하나라도 있거나 실행한 계약이 없으면 종료 코드 1이다. 계약이 실패하거나 러너가 오류로 종료하면 작업 디렉터리를 보존하고 경로를 출력한다. 통과하면 지운다.
6. SIGINT는 서버 프로세스, 컨테이너, 작업 디렉터리를 정리한 뒤 종료 코드 130으로 끝난다. 서버 기동을 기다리는 중이어도 프로세스를 남기지 않는다.

API 서버와 migration 프로세스의 env는 러너가 명시적으로 만든다. 부모 프로세스의 `STORIX_*`를 상속하지 않고 서버 cwd는 `.env`가 없는 임시 디렉터리다.

## 프로필

- 서버를 다시 띄워야 하는 이유는 기동 설정 차이뿐이다. 전역 한도 같은 값은 프로세스 시작 시 한 번만 읽힌다(`docs/design/04-namespace-logical-quota.md` "계약").
- 상태 격리는 namespace가 맡으므로 상태 오염은 재시작 이유가 아니다.
- `default`는 서버 기본값을 그대로 쓴다.
- `small-limits`는 파일 상한 1200, snapshot 상한 800, 논리 상한 2000 바이트와 동기 삭제·복사 노드 수 상한 5를 준다. 한도 계약(`contracts/limits/`, `delete-limit-rejection`, `copy-limit-rejection`)이 쓴다. namespace별 상한 재정의(`namespace-quota-override`)는 전역 상한이 2000이라는 전제를 쓴다. 값은 `src/runner/profiles.ts`가 정한다.
- `change-feed`는 전역과 사전 준비 namespace에 `change-feed` capability를 허용한다. capability 시작 설정(`STORIX_VFS_CAPABILITIES_CONFIG_PATH`)이 namespace ID를 시작 시 검증하므로 러너가 빈 설정으로 기동 → namespace를 프로필 계약 수의 두 배만큼 생성 → 그 ID를 넣은 설정을 쓰고 서버를 재시작한다. 계약의 `createNamespace()`는 이 namespace를 앞에서부터 하나씩 받고, 다 쓰면 오류를 던진다(꺼진 namespace를 몰래 만들지 않는다).

## 실행 옵션

- `pnpm contract [id...]`: 지정한 계약만 실행한다. 없으면 전체다.
- `--shuffle`: 실행 순서를 섞어 계약 간 숨은 의존을 드러낸다.
- `--coverage`: 계약이 없는 RQ를 출력한다. 서버를 기동하지 않고 종료 코드 0이다.
- `--contracts-dir <경로>`: 계약 디렉터리를 바꾼다.
- `--db sqlite|postgres`: 기본은 `sqlite`다. `postgres`는 러너가 docker CLI로 `postgres:16-alpine` 컨테이너를 실행당 1회 기동하고, 프로필마다 새 database(`storix_<실행 ID>_<프로필>`)를 만들어 같은 migration 진입점을 적용한다. 계약 코드는 드라이버를 모르며 차이는 `runner/database.ts`·`runner/postgres.ts`에만 있다. 드라이버 간 결과가 다르면 계약 위반 또는 문서화된 차이로 다룬다.

## 검증 범위

- 러너 로직(계약 정의, 발견·검증·그룹화, 요구사항 파서, env 구성, 결과 집계)은 `src/**/*.spec.ts` 단위 테스트가 고정한다.
- 서버 기동·재시작, 기동 대기 중 중단 시 서버 프로세스 정리, 기동 중 종료 오류, 잔여 컨테이너 제거는 `src/runner/runner-boot.integration-spec.ts`가 고정한다.
- 계약 통과는 그 실행의 드라이버(`--db`) 위에서 공개 HTTP 계약이 지켜졌다는 뜻이다. 배포 이미지·compose 기동, 운영 배포, 특정 소비자 연동은 검증한 것이 아니다.

## CI

`.github/workflows/contract.yml`이 실행한다.

- push(`dev`)·pull request: `pnpm contract`(SQLite). `apps/api/**`, `apps/contract/**`, `docs/requirements/**`, 루트 패키지·turbo 설정, 워크플로 파일이 바뀔 때만 실행한다.
- `workflow_dispatch`와 매주 월요일 03:00 KST: `pnpm contract --db postgres`.
- `release.yml`의 게이트로 연결하지 않았다.
