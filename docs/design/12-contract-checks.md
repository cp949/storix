# 계약 검증(contract)

## 목적

`apps/contract`는 소비자가 공개 HTTP API에 기대하는 동작을 실제 서버에 실행해 보장한다. 결정 배경은 `docs/adr/0029-contract-checks.md`다.

## 구성

- `src/define-contract.ts`: 계약 정의 API와 컨텍스트 타입.
- `src/contracts/<영역>/<id>.ts`: 계약 파일. 하나에 계약 하나다.
- `src/runner/lifecycle.ts`: 실행 작업 디렉터리·공유 blob/Postgres·프로필 순서·정리 결과를 관리한다.
- `src/runner/profile-lifecycle.ts`: 프로필 DB·API 서버·capability 준비·계약 실행을 관리한다.
- `src/runner/`: 계약 발견·검증, DB·서버·저장소 기동과 정리 도구.
- `src/client/api-client.ts`: 계약이 쓰는 HTTP 클라이언트.
- `src/cli.ts`: 인자·계약 검증과 선택을 수행한다. SIGINT 신호를 lifecycle에 전달하고 결과를 출력한다.

## 계약 정의

- `defineContract({ id, title, rq, profile?, run })`이 입력을 검증한다.
- `id`는 소문자 kebab-case이고 전체에서 유일하다.
- `rq`는 필수이고 각 값은 `docs/requirements/file-storage.md`에 있는 `RQ-NNN`이다.
- `skip`·`only` 옵션은 없다. 알 수 없는 옵션은 오류다.
- 계약 파일은 `default export`로 계약을 내보낸다. 파일을 추가하면 실행 대상이 된다.
- `run(ctx)`는 `node:assert/strict`로 검증하고 위반 시 throw한다.
- `ctx.signal`은 CLI의 실행 취소 신호다. `ctx.client`는 HTTP 요청과 응답 본문 대기에 같은 신호를 전달한다.
- `ctx`는 `baseUrl`, `apiKey`, `adminKey`(관리자 API 호출용, 서비스 key로는 인증되지 않는다), `client`(공개 HTTP 클라이언트), `createNamespace(options?)`, `server.restart()`, `blobStorage`(`stop()`·`start()`·`deleteAllObjects()`)를 제공한다. 프로필이 capability를 허용하면 `createNamespace()`는 그 capability가 켜진 namespace를 주고, `withoutCapabilities: true`를 주면 허용되지 않은 새 namespace를 API로 만든다. `server.restart()`는 같은 포트·env·DB로 서버를 다시 띄우며, 재시작 뒤 지속성·멱등성 재생을 검증하는 계약만 쓴다. `blobStorage`는 VersityGW 컨테이너를 멈추거나 되살리고 버킷 객체를 지우며 저장 장애 계약(`contracts/storage/`)만 쓴다. `deleteAllObjects()`는 버킷 전체를 지우므로 계약은 자기 namespace의 파일만 다루고 앞 계약이 만든 파일에 기대지 않는다. 컨테이너는 고정 호스트 포트로 띄운다(`docker stop` 뒤 `start`에서 임의 포트는 바뀐다). 러너는 계약이 끝날 때마다 멈춘 저장소를 되살리므로 실패한 계약이 뒤 계약을 막지 않는다.

## 작성 규약

- 계약은 `apps/api` 소스를 import하지 않는다. `apps/contract`는 `@cp949/storix-api`에 의존하지 않는다.
- 계약끼리 의존하지 않는다. 계약은 `ctx.createNamespace()`로 받은 자기 namespace만 쓴다.
- 정리 코드를 쓰지 않는다. 서버 종료가 정리한다.
- 시간 대기에 `sleep`을 쓰지 않는다.
- 직접 `fetch()`와 계약 내부 대기는 `ctx.signal`을 전달한다.
- 파일 머리 주석에 소비자 기대 한 문장과 대응 RQ를 쓴다.

## 실행 흐름

1. 계약을 발견하고 `id` 중복과 문서에 없는 RQ를 검사한다. 위반이면 서버를 기동하지 않고 종료 코드 1로 끝난다.
2. 실행 lifecycle이 작업 디렉터리를 만든다. 이전 실행이 남긴 `storix-contract-` 컨테이너를 제거한다.
3. VersityGW 컨테이너를 한 번 기동하고 버킷을 만든다. `--db postgres`이면 공유 Postgres 컨테이너도 준비한다.
4. 프로필 lifecycle을 순차 호출한다. 각 프로필은 새 SQLite 파일 또는 Postgres database에 migration을 적용하고 API 서버를 별도 프로세스로 기동한다.
5. capability 프로필은 namespace 생성·설정 파일 쓰기·서버 재시작을 마친 뒤 계약을 실행한다.
6. 계약을 순차 실행한다. 한 계약의 실패는 다음 계약 실행을 막지 않는다.
7. 프로필 lifecycle은 정상 반환과 실행 오류 모두에서 자기 서버를 종료한다. 실행 lifecycle은 기동 중인 서버도 추적해 정리하고 공유 자원을 정리한다.
8. CLI는 계약 집계와 실행·정리 오류 및 보존 경로를 출력한다. 종료 상태와 보존 정책은 "중단과 정리"를 따른다.

API 서버와 migration 프로세스의 env는 러너가 명시적으로 만든다. 부모 프로세스의 `STORIX_*`를 상속하지 않고 서버 cwd는 `.env`가 없는 임시 디렉터리다.

## 중단과 정리

- CLI는 SIGINT를 받으면 실행 신호를 한 번 취소한다. 반복 SIGINT도 정리를 생략하지 않는다.
- 계약과 모든 자원 정리가 성공하면 작업 디렉터리 삭제 직전에 완료를 확정한다. `ContractLifecycleInput.onFinalizing`은 이 경계를 CLI에 알린다.
- 완료 확정 뒤 CLI는 SIGINT를 무시한다. 디렉터리 삭제가 성공하면 종료 코드 `0`이며 보존 경로를 출력하지 않는다. 삭제 실패는 정리 오류로 종료 코드 `1`이다.
- 취소 이후 새 프로필·계약·capability provisioning·서버 재시작·저장소 `ensureRunning()`을 시작하지 않는다.
- provisioning은 namespace 생성마다, 설정 파일 쓰기 전, 서버 재시작 전에 취소를 확인한다.
- 컨텍스트의 namespace 생성·서버 재시작·저장소 제어는 호출 직전에 취소를 확인한다.
- 활성 프로필은 취소부터 최대 10초 기다린다. 기본값은 `ContractLifecycleDependencies.activeProfileGraceMs`다.
- 유예가 만료되면 미완료 프로필 Promise를 더 기다리지 않고 추적 서버 정리를 시작한다. 늦게 반환한 프로필 결과는 집계하지 않는다.
- 중단 결과를 모두 출력하면 stdout·stderr의 쓰기 완료를 기다린 뒤 CLI를 종료 코드 `130`으로 종료한다. 계약이 취소를 따르지 않고 interval·소켓을 남겨도 CLI를 유지하지 않는다.
- 서버는 SIGTERM으로 종료한다. 서버 종료 대기가 10초를 넘으면 SIGKILL을 보낸다.
- 실행 lifecycle의 정리 순서는 추적 서버 → Postgres → blob → 잔여 컨테이너다. 성공 실행은 마지막으로 작업 디렉터리를 삭제한다.
- 각 정리는 `CLEANUP_TIMEOUT_MS`의 기본 30초 제한을 갖는다. 실패·시간 초과를 기록하고 다음 정리를 계속 시도한다.
- Docker 정리 명령은 비동기로 실행한다. 제한 시간이 지나면 해당 명령 프로세스를 SIGKILL로 종료한다.
- 실행 오류와 정리 오류가 함께 있으면 원래 실행 오류를 보존한다. CLI는 모든 정리 오류도 별도로 출력한다.

| 결과                                              | 종료 코드 | 작업 디렉터리      |
| ------------------------------------------------- | --------- | ------------------ |
| 계약 통과와 정리 성공                             | `0`       | 삭제               |
| 계약 실패·실행 오류·정리 오류 또는 실행 계약 없음 | `1`       | 보존하고 경로 출력 |
| 완료 확정 전 SIGINT                               | `130`     | 보존하고 경로 출력 |

SIGINT 종료 코드가 정리 오류보다 우선한다. 정리 오류는 출력에서 확인한다.
계약 실패가 있는 프로필은 서버 로그 경로도 출력한다.

## 프로필

- 서버를 다시 띄워야 하는 이유는 기동 설정 차이뿐이다. 전역 한도 같은 값은 프로세스 시작 시 한 번만 읽힌다(`docs/design/04-namespace-logical-quota.md` "계약").
- 상태 격리는 namespace가 맡으므로 상태 오염은 재시작 이유가 아니다.
- `default`는 서버 기본값을 그대로 쓴다.
- `small-limits`는 파일 상한 1200, snapshot 상한 800, 논리 상한 2000 바이트와 동기 삭제·복사 노드 수 상한 5, 휴지통 보존 노드 수 상한 3을 준다. 한도 계약(`contracts/limits/`, `delete-limit-rejection`, `copy-limit-rejection`, `trash-retention-limit`)이 쓴다. namespace별 상한 재정의(`namespace-quota-override`)는 전역 상한이 2000이라는 전제를 쓴다. 값은 `src/runner/profiles.ts`가 정한다.
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
- 실행·프로필 lifecycle 단위 테스트는 취소 전파·후속 동작 차단·활성 프로필 유예·정리 순서·시간 제한·오류 우선순위를 고정한다.
- `src/cli-interrupt.integration-spec.ts`는 실제 CLI의 startup SIGINT와 SQLite/Postgres 활성 계약 SIGINT를 검증한다. 종료 코드·서버 PID 종료·컨테이너 제거·작업 디렉터리 보존과 경로 출력을 확인한다.
- 같은 통합 spec은 취소를 따르지 않는 SQLite interval 계약의 유예 뒤 CLI 종료도 검증한다. 성공 디렉터리 삭제 중 취소의 완료 경계는 lifecycle 단위 테스트가 고정한다.
- 계약 통과는 그 실행의 드라이버(`--db`) 위에서 공개 HTTP 계약이 지켜졌다는 뜻이다. 배포 이미지·compose 기동, 운영 배포, 특정 소비자 연동은 검증한 것이 아니다.

## CI

`.github/workflows/contract.yml`이 실행한다.

- push(`dev`)·pull request: `pnpm contract`(SQLite). `apps/api/**`, `apps/contract/**`, `docs/requirements/**`, 루트 패키지·turbo 설정, 워크플로 파일이 바뀔 때만 실행한다.
- `workflow_dispatch`와 매주 월요일 03:00 KST: `pnpm contract --db postgres`.
- `release.yml`의 게이트로 연결하지 않았다.
