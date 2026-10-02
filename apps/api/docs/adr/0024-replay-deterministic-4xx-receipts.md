# 조건부 mutation은 결정적 4xx 응답도 receipt로 저장해 30일 재생한다

다음 작업은 `Idempotency-Key`와 `X-Mutation-Scope`로 식별하는 receipt를 쓴다.

- 조건부 VFS 변경: `POST /fs/mutations`.
- 조건부 콘텐츠 업로드: `POST /fs/content/conditional`.
- snapshot 생성·복원·삭제.

이 결정 전에는 성공 응답과 요청 파싱 오류만 저장했다.

- snapshot은 파싱 오류를 모두 저장했다. `VFS_INVALID_PATH`와 restore의 428도 포함했다.
- mutation·content는 파싱 오류 중 `VFS_INVALID_PATH`만 claim을 release했다.
- 세 서비스 모두 작업 단계의 404·409·412·413은 저장하지 않았다.
- 같은 key로 재시도하면 작업 단계의 상태를 다시 평가했다.

이 결정은 작업 단계의 결정적 4xx도 저장하도록 바꾼다.
저장 경계·분류표·드라이버별 보장 범위는 `docs/design/02-receipt-error-replay.md`에 둔다.
HTTP 계약은 `apps/api/openapi.yaml`에 둔다.

**재생 대상**:

- 파싱 오류와 작업 중 던져진 `DomainError` 중 status 400–499를 저장한다.
- 404·409·412·428, 결정적 413(삭제·복사·snapshot 상한), `VFS_INVALID_PATH`를 포함한다.
- 세 서비스는 `isReplayableMutationError`로 분류한다.
- 같은 key와 같은 fingerprint의 재시도에는 최초 status·body·`X-Request-Id`를 재생한다.
- 보존 기간은 완료 시점부터 30일이다.

파싱 오류 처리 순서:

1. claim 전에 파싱하고 오류를 보류한다.
2. claim 결과를 확인한다.
   - 완료 receipt가 있으면 재생하거나 `MUTATION_KEY_REUSED`를 반환한다.
   - 진행 중이면 `MUTATION_IN_PROGRESS`를 반환한다.
   - `owner`일 때만 보류한 파싱 오류를 저장한다.

**재생 제외**:

- 5xx.
- `DomainError`가 아닌 예외(DB·Blob 장애).
- 401.
- `MUTATION_IN_PROGRESS`와 `MUTATION_KEY_REUSED`.
- `NAMESPACE_NOT_FOUND`. receipt의 namespace FK 때문에 저장할 수 없다.
- `Retry-After` 헤더는 저장하지 않는다.

**재생 불가**:

fingerprint 또는 claim 전에 끝나는 오류는 receipt가 없다.
재시도에서 최초 응답 bytes의 동일성을 보장하지 않는다.

- JSON 본문 16 KiB 초과: 413.
- 잘못된 key·scope 헤더: 400.
- namespace 부재: 404.
- restore·delete의 UUID 형식이 아닌 `snapshotId`: 404.
- content의 `Content-Length` 오류·파일 크기 상한 413 등.

**저장 경계**:

1. 작업 트랜잭션을 롤백한다.
2. 별도의 짧은 트랜잭션에서 `generation`·lease fencing으로 오류 receipt를 저장한다.
3. 저장이 끝난 뒤 응답한다.

롤백과 저장 사이에 프로세스가 종료되면 claim이 lease 만료까지 남는다.
만료 후 재시도는 상태를 재평가한다.

오류 receipt 확정이 claim lost로 실패하면 namespace 상태에 따라 응답한다.

- namespace가 이미 삭제됐으면 저장할 수 없는 404 `NAMESPACE_NOT_FOUND`를 반환한다.
- namespace가 남아 있거나 상태 조회가 실패하면 원래 claim-lost 오류를 유지한다.

**412 `current`**:

- 412 body에 충돌 시점의 노드 metadata(`stat` 응답 필드)와 `revision`(`r1.`)을 담는다.
- 노드가 없으면 `null`이다.
- 소비자는 `revision`으로 충돌 시점 ETag를 만들 수 있다.
- `revision`은 412 `current` 전용 shape에만 둔다.
- `stat` 응답의 `VfsNode`는 바꾸지 않는다.
- 재생 응답은 `revision`을 포함해 최초 값을 유지한다.

**snapshot `sourceRevision`**:

FILE snapshot 생성 요청의 선택 필드다.
캡처와 같은 트랜잭션에서 다음 순서로 판정한다.
PostgreSQL에서는 root 잠금 아래 판정한다.

1. 원본 부재: 404.
2. 디렉터리: 409.
3. revision 불일치: 412.

불일치하면 행을 만들지 않는다.
`sourceRevision`을 생략하면 fingerprint는 기존과 같다.

## Considered Options

- **412·404·413을 저장하지 않고 재평가**:
  - 이 결정 전의 동작이다.
  - VFS 상태가 바뀌면 같은 key의 결과도 바뀐다.
  - 최초 412가 재시도에서 성공할 수 있다.
  - 호출자가 재시도 결과를 최초 시도의 결과로 취급할 수 없다.
  - 최초 응답 재생 계약이 성공 응답에만 성립한다.
  - `VFS_INVALID_PATH`의 release 여부도 서비스마다 달랐다.
  - 재시도 의미를 통일하기 위해 기각했다.
- **412만 저장**:
  - 조건 충돌은 해결하지만 404·413·`VFS_INVALID_PATH`의 모호함은 남는다.
  - 분류 규칙에 예외 목록이 늘어나 기각했다.
  - status 범위로 분류하면 세 서비스에 같은 규칙을 적용할 수 있다.
- **모든 4xx·5xx 저장**:
  - 5xx와 일시 오류를 30일 고정하면 복구 뒤에도 실패가 재생된다.
  - 5xx와 일반 예외는 재평가해야 하므로 기각했다.
- **작업 트랜잭션 안에서 오류 receipt 저장**:
  - 오류가 나면 변경을 롤백해야 한다.
  - PostgreSQL은 abort된 트랜잭션을 재사용할 수 없다.
  - 롤백 뒤 별도 트랜잭션에 저장한다.

## Consequences

- 404·412·413·`VFS_INVALID_PATH` 뒤 상태나 입력을 고쳐 재시도하려면 **새 key**를 쓴다.
  같은 key와 같은 fingerprint는 최초 오류를 재생한다.
  fingerprint가 다르면 409 `MUTATION_KEY_REUSED`를 받는다.
- content endpoint는 조건이 유효하지 않으면 fingerprint의 조건 자리에 원본 헤더 값을 담는다.
  이 결정 전에는 다음 파싱 오류를 고정 문자열 `invalid`(JSON `"invalid"`)로 저장했다.
  - 428.
  - 잘못된 조건 헤더 400.
  - `VFS_INVALID_REVISION` 400.
  - 유효한 헤더로 보낸 루트 경로 `/` 400.

  기존 `invalid` fingerprint로 저장된 요청을 재시도하면 `MUTATION_KEY_REUSED`를 받는다.
  영향은 남은 보존 기간이며 최대 30일이다.
  이 결정 당시 endpoint는 미릴리즈 상태였다(api ADR-0020 기준).
  해당 receipt는 변경 전 미릴리즈 중간 빌드에서만 생긴다.
  mutation·snapshot의 기존 receipt와 조건이 유효한 content receipt의 fingerprint는 유지한다.

  snapshot 생성의 `sourceRevision`에는 예외가 있다.
  변경 전 빌드는 이 키를 허용하지 않아 400 `VFS_INVALID_MUTATION_REQUEST`로 저장했다.
  변경 후 유효하게 파싱되면 fingerprint가 달라진다.
  같은 요청을 재시도하면 `MUTATION_KEY_REUSED`를 받는다.
  이 endpoint도 결정 당시 미릴리즈 상태였다.

- 재생 불가 오류는 입력을 고쳐 재시도할 수 있다.
  소비자는 응답 bytes의 동일성에 의존하지 않는다.
- SQLite는 연결 하나를 모든 요청이 공유한다.
  [api ADR-0025](./0025-sqlite-query-gate.md)의 게이트가 모든 쿼리를 직렬화한다.
  receipt claim과 `sourceRevision` 비교·캡처의 원자성은 같은 프로세스의 동시 요청에도 성립한다.
  게이트 대기 상한을 넘으면 503 `DB_BUSY`로 실패한다.
  5xx는 receipt로 저장하지 않는다.
- **api ADR-0020의 breaking change 기준**:
  - 엔드포인트·필수 필드·상태 코드 의미·인증 방식은 바꾸지 않는다.
  - 응답 필드를 제거하거나 개명하지 않는다.
  - `sourceRevision`은 선택 필드다.
  - `current`와 그 안의 `revision`은 412 body에 추가한 필드다.
  - `ErrorResponse`는 추가 속성을 허용한다.
  - 최초 평가의 status·body는 유지한다.
  - 같은 key 재시도의 결과만 재생으로 바꾼다.
  - 결정 당시 대상 endpoint는 모두 `[Unreleased]`에서 추가돼 릴리즈된 계약에 없었다.
  - `/api/v2` 교체 대상이 아니다.
  - `CHANGELOG.md`의 `Changed`에 재시도 동작 변경을 명시한다.
  - ADR-0007의 `**BREAKING**:` 접두사는 붙이지 않는다.
    원천은 `docs/adr/0007-semver-release-versioning-package-json-inert.md`다.
