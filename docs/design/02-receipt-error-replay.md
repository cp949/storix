# 조건부 mutation receipt의 오류 재생과 snapshot sourceRevision

조건부 VFS 변경(`POST /fs/mutations`), 조건부 콘텐츠 업로드(`POST /fs/content/conditional`), snapshot 생성·복원·삭제
(`POST /fs/snapshots...`)는 `Idempotency-Key` + `X-Mutation-Scope`로 식별하는 receipt(`vfs_mutation_receipt`)를 쓴다. 이
문서는 receipt가 어떤 오류를 저장·재생하는지, 저장 시점과 경계, FILE snapshot 생성의 `sourceRevision` 조건, 드라이버별
직렬화 차이, 검증 범위를 정한다. 결정과 대안은 [ADR-0024](../../apps/api/docs/adr/0024-replay-deterministic-4xx-receipts.md),
계약(요청·응답 형태)은 `apps/api/openapi.yaml`, 드라이버 공통 규칙은 [01](./01-db-driver-portability.md).

## 1. 범위와 용어

- receipt identity는 `namespace/scope/key`다. 완료된 receipt는 method, fingerprint, 응답 status·body·헤더를 저장한다.
- 세 서비스(`mutation.service.ts`, `conditional-content.service.ts`, `vfs-snapshot.service.ts`)는 저장·재생 규칙을
  `vfs/mutation-receipt.ts` 한 모듈에서 공유한다. 서비스별로 다른 규칙을 두지 않는다.
- receipt 상태는 `RESERVED`(claim 소유 중, lease 보유)와 `COMPLETE`(응답 확정)다. `RESERVED` lease 기본값은 60초
  (`STORIX_MUTATION_LEASE_SECONDS`)다. 보존 기한은 **완료 시점부터** 30일이다(claim 시점이 아니다).
- `current`: 412 응답 body에 실리는 충돌 시점의 노드 metadata와 `revision`(4절).

## 2. 저장 경계

요청 처리 순서와 receipt 저장 위치는 다음과 같다.

1. snapshot restore·delete는 먼저 `canonicalSnapshotId`로 `snapshotId`를 검사한다(UUID 형식이 아니면 404, 3.3).
2. 헤더 검증(`identityOf`), namespace root 확인, 요청 파싱. 파싱 오류는 던지지 않고 보류한다. mutation·snapshot은 이어서
   fingerprint를 계산한다.
3. `receipts.claim`: `owner` / `complete`(재생 또는 `MUTATION_KEY_REUSED`) / `busy`(409 `MUTATION_IN_PROGRESS` +
   `Retry-After`) 중 하나. 보류한 파싱 오류는 `owner`일 때만 저장하므로 `complete`·`busy`의 응답이 파싱 오류보다 우선한다.
4. content는 claim 뒤 `Content-Length`를 검사하고 본문을 해시한 다음 fingerprint를 계산한다. `complete`이거나 파싱 오류가
   있으면 업로드 없이 해시만 하고, 그 외에는 업로드하면서 해시한다.
5. `owner`이고 파싱 오류가 있으면 작업 트랜잭션 없이 바로 `storeErrorReceipt`로 저장한다.
6. `owner`이고 파싱에 성공했으면 `withMutation` 트랜잭션에서 변경을 수행한다. 성공하면 같은 트랜잭션에서
   `receipts.complete`를 호출한다.
7. 6단계에서 `DomainError`가 던져지면 트랜잭션이 롤백된다. 롤백 뒤 `storeErrorReceipt`가 저장 대상인지 판정하고,
   대상이면 **별도의 짧은 트랜잭션**에서 `receipts.completeAfterRollback`으로 오류 응답을 저장한다. 5단계의 저장도 같은
   함수와 같은 짧은 트랜잭션을 쓴다.
8. 응답은 receipt 저장이 끝난 뒤에만 보낸다.

- 별도 트랜잭션을 쓰는 이유: PostgreSQL에서 오류가 난 트랜잭션은 abort 상태라 재사용할 수 없고, 변경은 롤백돼야 하므로
  오류 receipt를 같은 트랜잭션에 넣을 수 없다.
- fencing: `completeAfterRollback`은 성공 경로의 `complete`와 같은 조건(`state = 'RESERVED'`, `generation` 일치,
  `lease_expires_at > now`)으로 갱신한다. 조건이 맞지 않으면(claim을 잃음) `Error('VFS mutation claim lost')`를 던지며
  응답을 보내지 않는다. 이 오류는 저장 대상이 아니라 호출부가 `release`(generation 조건부 삭제)하고 500으로 끝난다.
  새 owner의 claim은 지우지 않는다.
- 롤백과 저장 사이에 프로세스가 종료되면 claim이 `RESERVED`로 남는다. 응답이 나간 적이 없으므로, lease가 만료된 뒤
  같은 key의 요청이 claim을 인수(`generation + 1`)해 다시 평가한다.
- content 업로드에서 반영이 실패하면(트랜잭션 롤백 또는 claim lost) 업로드한 object 삭제를 시도하고 삭제 실패는 무시한다.
  이 object를 가리키는 Blob row는 없다. 순서는 롤백 → object 삭제 → 오류 receipt 저장이다.
- 저장 body에 `requestId`가 들어 있고 헤더 `X-Request-Id`도 최초 값이다. 재생 응답은 이 두 값을 그대로 돌려준다.
  `Retry-After`는 저장하지 않는다(진행 중 응답은 receipt 대상이 아니다).

## 3. 오류 분류

분류 판정은 `isReplayableMutationError` 하나가 한다.

### 3.1 저장하고 재생한다

claim이 `owner`인 요청의 파싱 오류(claim 전에 보류한 것)와 작업 중 던져진 `DomainError` 중 status 400–499이며 아래 제외
항목에 없는 것이다. 같은 key에 완료 receipt가 있으면 재생 또는 `MUTATION_KEY_REUSED`, 진행 중이면 `MUTATION_IN_PROGRESS`가
파싱 오류보다 우선한다.

| 종류 | 예 |
| --- | --- |
| 요청 형식·경로 오류 400 | `VFS_INVALID_PATH`(NFC 아닌 경로 포함), `VFS_INVALID_MUTATION_REQUEST`, `VFS_INVALID_REVISION` |
| 대상 부재 404 | `VFS_NODE_NOT_FOUND`(원본·부모·snapshot 부재) |
| 상태 충돌 409 | `VFS_NOT_DIRECTORY`, `VFS_IS_DIRECTORY`, `VFS_DIRECTORY_NOT_EMPTY`, `VFS_INVALID_OPERATION`, `VFS_REVISION_EXHAUSTED` 등 |
| 조건 불일치 412 | `VFS_PRECONDITION_FAILED`(`current` 포함) |
| 결정적 상한 413 | `VFS_DELETE_LIMIT_EXCEEDED`, `VFS_COPY_LIMIT_EXCEEDED`, `VFS_SNAPSHOT_LIMIT_EXCEEDED` |
| 조건 누락 428 | `VFS_PRECONDITION_REQUIRED` |

- 같은 key와 같은 fingerprint의 재시도는 그 사이 VFS 상태가 바뀌었어도 최초 status·body·`X-Request-Id`를 재생한다.
  완료 시점부터 30일이 지나 만료된 receipt는 claim 시 삭제되고 새로 평가한다.
- 다른 fingerprint(경로·조건·본문·`sourceRevision`이 다른 요청)는 409 `MUTATION_KEY_REUSED`다. 오류 뒤 경로를 고친 요청도
  같은 key에서는 이 응답을 받는다.

### 3.2 저장하지 않는다(재시도가 다시 평가한다)

| 종류 | 처리 |
| --- | --- |
| 5xx `DomainError`, `DomainError`가 아닌 예외(DB·Blob 장애, claim lost) | claim `release`. 재시도는 새로 평가 |
| 409 `MUTATION_IN_PROGRESS` | 다른 요청이 claim을 소유 중. receipt를 건드리지 않음 |
| 409 `MUTATION_KEY_REUSED` | 기존 receipt의 상태를 알리는 응답 |
| 404 `NAMESPACE_NOT_FOUND` | receipt가 namespace FK를 가져 저장 불가 |
| 401 | 자격 증명 결과이며 서비스에 도달하지 않음 |

### 3.3 재생 불가(receipt를 만들기 전에 끝남)

fingerprint 또는 claim 이전에 끝나는 오류라 receipt가 없다. 같은 요청을 재시도하면 같은 상한·같은 상태에서 같은
status와 오류 코드가 나오지만, 응답 bytes(`requestId` 포함)의 동일성은 보장하지 않는다.

| 오류 | 발생 위치 |
| --- | --- |
| 413 JSON 본문 16 KiB 초과 | body parser(`configureBodyParsers`), 컨트롤러 도달 전 |
| 400 잘못된 `Idempotency-Key` 또는 `X-Mutation-Scope` | `identityOf`, claim 전 |
| 404 namespace 부재 | root 확인, claim 전. FK 때문에 저장도 불가 |
| 404 UUID 형식이 아닌 `snapshotId`(restore·delete) | 서비스 진입 직후, claim 전 |
| 400 `Content-Length` 형식 오류 | content: fingerprint(raw body SHA-256) 계산 전 |
| 413 선언한 `Content-Length`가 파일 크기 상한 초과 | content: 같은 위치 |
| 413 업로드·해시 스트리밍 중 파일 크기 상한 초과 | content: fingerprint 확정 전 |

content 업로드의 파일 크기 상한 413은 request body를 끝까지 해시하지 못하므로 어떤 경로에서도 재생 대상이 아니다.

### 3.4 호출자 규칙

| 응답 | 같은 key 재시도 |
| --- | --- |
| 5xx, 연결 끊김, 응답 미수신 | 가능. receipt가 있으면 재생, 없으면 새로 평가 |
| 409 `MUTATION_IN_PROGRESS` | `Retry-After` 뒤 가능 |
| 404·412·413(상한)·400·409·428을 받은 뒤 상태 또는 입력을 고친 경우 | 최초 오류가 재생되거나 `MUTATION_KEY_REUSED`. 새 key 사용 |
| 3.3의 오류 | 입력을 고쳐 재시도. 재생 보장 없음 |

## 4. 412 `current`

- 값: 충돌 시점에 `work`(트랜잭션 본문, 롤백 전) 안에서 읽은 노드 metadata에 그 노드의 `revision`을 더한 객체다.
  metadata 필드는 `GET /fs/stat` 응답과 같고(`toNodeResponse`), `revision`은 `r1.` 토큰(`encodeRevision(node)`)이다.
  노드가 없으면 `null`이다. 소비자는 `current.revision`으로 충돌 시점 ETag를 만든다.
- shape: `VfsPreconditionCurrentDto`(`VfsNodeResponseDto` + `revision`)를 `toPreconditionCurrent`가 만든다.
  `revision`은 412 `current`에만 있다. `GET /fs/stat` 등 다른 응답의 `VfsNodeResponseDto`에는 없다.
- 생성 지점(`VfsPreconditionFailedError`): revision 불일치(delete·move/copy 원본·content 교체·restore), mkdir 대상 존재,
  move/copy 목적지 충돌, content·restore `ifAbsent` 위반, snapshot `sourceRevision` 불일치, `ls` 만료 cursor
  (`current`는 디렉터리 metadata).
- 오류 객체가 `current`를 들고 `resolveErrorCurrent`가 body에 직렬화한다. `DomainErrorFilter`와 receipt용
  `errorResponse`가 같은 함수를 써서 두 경로의 body가 같다. `current`가 `undefined`인 오류에는 키를 만들지 않아 다른
  오류 코드의 body는 바뀌지 않는다.
- receipt에 저장된 body이므로 재생 시 `current`(`revision` 포함)는 최초 값이다. 이후 파일 변경을 반영하지 않으며, 재생된
  `current.revision`은 충돌 시점 revision과 같다. `ls` 412는 receipt가 없는 조회 API라 매 요청 현재 값을 담는다.

## 5. snapshot `sourceRevision` 조건

FILE snapshot 생성 요청의 선택 필드다. `kind: 'file'`에서만 허용한다.

- 검증 순서(`parseSnapshotCreateRequest`): 허용 키 검사 → `kind`·`path` 형식 → `sourceRevision`이 있고 `kind`가
  `tree`이거나 문자열이 아니면 400 `VFS_INVALID_MUTATION_REQUEST` → 경로 정규화 → `decodeRevision`(형식 오류 400
  `VFS_INVALID_REVISION`). 경로와 revision이 모두 틀리면 경로 오류(`VFS_INVALID_PATH`)가 먼저 나온다. 모두 저장 대상이다.
- 키를 생략하면 기존 동작이며, 정규화 command에 `sourceRevision` 키를 만들지 않는다. `null`은 생략으로 취급하지 않는다.
  `null`을 포함해 문자열이 아닌 값은 400 `VFS_INVALID_MUTATION_REQUEST`다. 따라서 요청에 `sourceRevision` 키가 없으면
  fingerprint가 조건 도입 전과 같고 기존 receipt와 호환된다.
- 비교 위치: `VfsSnapshotService.create`의 `withMutation` 트랜잭션 안에서, `captureSnapshotRows`가 원본 행을 읽은 뒤
  `capture`(보존 예산 UPDATE·manifest·Blob ref 증가) 앞이다. 비교값은 `rows[0].revision`(정규 인코딩 문자열)과
  `sourceRevision`의 문자열 비교이며, revision은 노드 id와 version을 인코딩하므로 id 또는 version이 다르면 불일치다.
- 검사 순서: 원본 부재 404 → 원본이 디렉터리 409(`VFS_IS_DIRECTORY`) → revision 불일치 412(`current` = 같은 트랜잭션에서
  다시 읽은 원본 metadata + `revision`).
- 불일치 시 `capture`를 호출하지 않으므로 snapshot·manifest·Blob ref·보존 예산 사용량이 만들어지지 않는다.
- fingerprint에 `sourceRevision`이 포함되므로 같은 key에서 값을 바꾸거나 추가·제거하면 `MUTATION_KEY_REUSED`다.
- 412는 3절 규칙대로 receipt에 저장되어, 원본이 다시 바뀐 뒤에도 같은 key 재시도는 최초 412와 `current`를 재생한다.
  최신 상태를 평가하려면 새 key를 쓴다.

## 6. 드라이버별 직렬화와 보장 범위

| 항목 | PostgreSQL | SQLite |
| --- | --- | --- |
| namespace root 행 잠금 | `withMutation`이 `pessimistic_write`(`FOR UPDATE`)로 잠근다. 같은 namespace의 writer와 snapshot 캡처가 root 잠금에서 선형화된다 | 잠금 호출을 생략한다(`applyRowLockIfSupported`가 쿼리를 그대로 반환) |
| `sourceRevision` 비교와 캡처의 원자성 | root 잠금 아래에서 비교와 캡처가 이어져 그 사이에 다른 writer가 끼어들지 않는다 | 쿼리 게이트가 트랜잭션을 직렬화해 보장한다(아래) |
| 오류 receipt 저장 | 작업 트랜잭션 롤백 뒤 별도 트랜잭션 | 같은 방식 |

- SQLite 드라이버(TypeORM better-sqlite3)는 연결 하나를 모든 요청이 공유하므로, 앱이 모든 쿼리를 FIFO 게이트로 직렬화한다
  ([01](./01-db-driver-portability.md)의 SQLite 쿼리 게이트). 트랜잭션 하나가 게이트를 끝까지 쥐고, 다른 트랜잭션과
  트랜잭션 밖 쿼리(receipt `claim` 포함)는 그동안 기다린다. 그래서 root 행 잠금이 없어도 같은 프로세스 안의 동시 요청이
  선형화되고, `sourceRevision` 비교와 캡처의 원자성이 성립한다.
- 대기가 상한을 넘으면 그 쿼리는 실행하지 않고 503 `DB_BUSY`로 실패한다. 5xx라 receipt로 저장하지 않으므로 같은 key로
  재시도하면 처음부터 다시 평가한다.
- SQLite는 단일 프로세스 배포 전용이다([01](./01-db-driver-portability.md) 1절).
- 두 드라이버에서 receipt 저장·재생 로직과 fingerprint 계산은 같은 코드다. 차이는 root 행 잠금 유무다.

## 7. content fingerprint

- `POST /fs/content/conditional` fingerprint의 경로 자리는 정규화에 성공하면 정규 경로, 실패하거나 루트 경로(`/`)라
  거부되면 원본 경로 문자열이다.
- 조건 자리는 `parsePrecondition`이 성공하면 정규화 조건, 그 외에는 원본 `X-If-Absent`·`X-If-Revision` 헤더 값이다.
  `parsePrecondition`은 경로 검사를 통과한 뒤에만 호출되므로, 경로 정규화가 실패하거나 루트 경로(`/`)라 거부되면 조건이
  유효해도 원본 헤더 값이 들어간다.
- 서로 다른 잘못된 헤더 조합과 경로는 같은 key에서 서로의 오류를 재생하지 않는다.
- 스키마 마이그레이션은 없다. 기존 테이블 컬럼만 쓴다.

## 8. 검증 범위

검증한 것:

- 단위(`pnpm --filter @storix/api test`): 분류기(저장 대상·제외 코드·status 경계), `storeErrorReceipt`의 fencing 실패,
  세 서비스의 저장·release 분기, content fingerprint 조합, `sourceRevision` DTO 검증·비교 순서·fingerprint 호환,
  OpenAPI와 컨트롤러 라우트 정합(`route-coverage.spec.ts`).
- PostgreSQL 통합(`fs.integration-spec.ts`, `vfs-node.repository.integration-spec.ts`,
  `vfs-mutation-receipt.repository.integration-spec.ts`): 412·404·413·`VFS_INVALID_PATH` 재생과 `current` 고정,
  5xx·일반 오류의 비저장, 진행 중 claim, 앱 재시작 뒤 재생, `sourceRevision` 불일치 시 행 불변.
  root 행을 잠근 트랜잭션으로 순서를 강제해 "snapshot 선행 → writer 후행", "writer 선행 → snapshot 412" 두 경우를 확인했다.
- SQLite 통합(`test:integration:sqlite`): 오류 receipt의 재시작 뒤 재생, `sourceRevision` 일치·불일치.

검증하지 않은 것:

- 동시성은 PostgreSQL 통합 테스트에서만 검증했고, 그것도 root 잠금으로 순서를 강제한 두 경우다. 임의 인터리빙을 무작위로
  생성하는 검증은 하지 않았다. SQLite에서는 `sourceRevision` 비교와 writer의 동시 실행을 검증하지 않았다.
- 프로세스 강제 종료(롤백과 receipt 저장 사이, 업로드 중)와 lease 만료 뒤 인수는 통합 수준에서 실제 프로세스 종료로
  확인하지 않았다. "앱 재시작"은 Nest 애플리케이션을 닫고 같은 DB로 다시 만드는 테스트다.
- receipt를 포함한 운영 백업·복구와 30일 만료 정리(`pruneExpired`)의 오류 receipt 대상 동작은 별도로 확인하지 않았다.
- 기존 receipt와의 호환(ADR-0024 Consequences)은 fingerprint 코드 경로로 판단했고 기존 빌드가 저장한 데이터로 실행해
  확인하지 않았다.
