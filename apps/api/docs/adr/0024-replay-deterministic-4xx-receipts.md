# 조건부 mutation은 결정적 4xx 응답도 receipt로 저장해 30일 재생한다

조건부 VFS 변경(`POST /fs/mutations`), 조건부 콘텐츠 업로드(`POST /fs/content/conditional`), snapshot 생성·복원·삭제는
`Idempotency-Key` + `X-Mutation-Scope`로 식별하는 receipt를 쓴다. 이전에는 성공 응답과 요청 파싱 단계 오류만 receipt로
저장했다. snapshot 서비스는 파싱 단계 오류를 모두(`VFS_INVALID_PATH`, restore 428 포함) 저장했고, mutation·content는 파싱
단계 오류 중 `VFS_INVALID_PATH`만 claim을 release하고 나머지를 저장했다. 세 서비스 모두 작업 단계의 404·409·412·413은
저장하지 않아 같은 key 재시도가 상태를 다시 평가했다. 이 ADR은 그 규칙을 바꾼다. 저장 경계·분류표·드라이버별 보장 범위는
`docs/design/02-receipt-error-replay.md`, 계약은 `openapi.yaml`이 기술한다.

- **재생 대상**: 파싱 오류와 작업 중 던져진 `DomainError` 중 status 400–499. 404·409·412·428, 결정적
  413(삭제·복사·snapshot 상한), `VFS_INVALID_PATH`를 포함한다. 파싱은 claim 전에 실행하고 오류를 보류했다가 claim이
  `owner`일 때만 저장한다. 따라서 같은 key에 완료 receipt가 있으면 재생 또는 `MUTATION_KEY_REUSED`, 진행 중이면
  `MUTATION_IN_PROGRESS`가 파싱 오류보다 우선한다. 같은 key와 같은 fingerprint의 재시도는 최초 status, body,
  `X-Request-Id`를 완료 시점부터 30일 재생한다. 세 서비스가 같은 분류기(`isReplayableMutationError`)를 쓴다.
- **재생 제외**: 5xx, `DomainError`가 아닌 예외(DB·Blob 장애), 401, `MUTATION_IN_PROGRESS`, `MUTATION_KEY_REUSED`,
  `NAMESPACE_NOT_FOUND`(receipt가 namespace FK를 가져 저장 불가). `Retry-After`는 저장하지 않는다.
- **재생 불가**: fingerprint 또는 claim 이전에 끝나는 오류(JSON 본문 16 KiB 초과 413, 잘못된 key·scope 헤더 400, namespace
  부재 404, restore·delete의 UUID 형식이 아닌 `snapshotId` 404, content의 `Content-Length` 오류·파일 크기 상한 413 등)는
  receipt가 없다. 재시도해도 최초 응답 bytes의 동일성을 보장하지 않는다.
- **저장 경계**: 작업 트랜잭션이 롤백된 뒤 별도의 짧은 트랜잭션에서 `generation`·lease fencing으로 저장하고, 저장이 끝난
  뒤에만 응답한다. 롤백과 저장 사이에 프로세스가 종료되면 claim이 lease 만료까지 남았다가 재평가된다.
- **412 `current`**: 412 body에 충돌 시점의 노드 metadata(`stat` 응답 필드)와 그 노드의 `revision`(`r1.`)을 싣는다. 노드가
  없으면 `null`이다. 소비자가 충돌 시점 ETag를 만들 수 있게 `revision`을 포함한다. `revision`은 412 `current` 전용
  shape에만 있고 `stat` 응답의 `VfsNode`는 바뀌지 않는다. receipt에 고정되므로 재생 시 `revision`을 포함해 최초 값이다.
- **snapshot `sourceRevision`**: FILE snapshot 생성 요청의 선택 필드. 캡처와 같은 트랜잭션(PostgreSQL은 root 잠금 아래)에서
  원본 부재 404 → 디렉터리 409 → revision 불일치 412 순서로 판정하고, 불일치면 아무 행도 만들지 않는다. 없으면
  fingerprint는 기존과 같다.

## Considered Options

- **412·404·413을 저장하지 않고 재시도마다 재평가(이전 동작)**: 그 사이 VFS 상태가 바뀌면 같은 key가 시점마다 다른
  결과를 낸다(412가 재시도에서 성공으로 바뀔 수 있다). 호출자는 재시도 결과를 최초 시도의 결과로 취급할 수 없고, "같은 key는
  최초 응답을 재생한다"는 계약이 성공 응답에만 성립한다. 세 서비스의 규칙도 어긋나 있었다(`VFS_INVALID_PATH`는 서비스마다 release 여부가
  달랐다). 기각.
- **412만 저장**: 조건 충돌이라는 가장 흔한 경우는 해결하지만, 404·413·`VFS_INVALID_PATH`에서 같은 모호함이 남고 분류 규칙이
  예외 목록으로 늘어난다. 상태 코드 범위 하나로 판정하는 규칙이 단순하고 세 서비스에 그대로 적용된다. 기각.
- **모든 4xx·5xx 저장**: 5xx와 일시 오류를 30일 고정하면 복구 뒤에도 실패가 재생된다. 5xx와 일반 예외는 재평가해야 하므로
  기각.
- **오류 receipt를 작업 트랜잭션 안에서 저장**: 오류가 나면 변경을 롤백해야 하고 PostgreSQL에서는 abort된 트랜잭션을 재사용할
  수 없다. 롤백 뒤 별도 트랜잭션에서 저장한다.

## Consequences

- 404·412·413·`VFS_INVALID_PATH` 뒤 상태 또는 입력을 고쳐 재시도하는 호출자는 **새 key**를 써야 한다. 같은 key는 최초 오류를
  재생하거나 fingerprint가 다르면 409 `MUTATION_KEY_REUSED`를 받는다.
- content endpoint fingerprint의 조건 자리는 유효하지 않은 조건이면 원본 헤더 값을 담는다. 이 규칙 이전에는 파싱 단계 오류
  전부(428, 잘못된 조건 헤더 400, `VFS_INVALID_REVISION` 400, 유효한 헤더로 보낸 루트 경로 `/` 400)가 조건 자리에
  고정 문자열 `invalid`(JSON `"invalid"`)를 넣은 fingerprint로 저장됐다. 그 fingerprint로 저장된 receipt와 같은 요청은 재생 대신
  `MUTATION_KEY_REUSED`를 받고, 영향은 남은 보존 기간(최대 30일)이다. 이 endpoint는 릴리즈된 버전에 없어(마지막 항목의 ADR-0020 기준)
  해당 receipt는 이 규칙 이전의 미릴리즈 중간 빌드에서만 생긴다. mutation·snapshot의 기존 receipt와 조건이 유효한 content
  receipt는 fingerprint가 바뀌지 않는다. 예외: 변경 전 빌드에서 `sourceRevision` 키를 담아 허용되지 않은 키 400
  (`VFS_INVALID_MUTATION_REQUEST`)으로 저장된 snapshot 생성 receipt는, 그 요청이 이제 유효하게 파싱되면 fingerprint가 달라
  같은 재시도가 `MUTATION_KEY_REUSED`를 받는다(해당 endpoint 미릴리즈).
- 재생 불가 오류는 receipt가 없다. 소비자는 그 오류를 받았을 때 입력을 고쳐 재시도하고, 응답 bytes의 동일성에 의존하지 않는다.
- SQLite 드라이버는 연결 하나를 모든 요청이 공유하고 앱에 트랜잭션을 직렬화하는 장치가 없어, 같은 프로세스 안에서도
  동시 요청의 트랜잭션이 직렬화·격리되지 않는다. 겹친 요청은 오류(`cannot start a transaction within a transaction`)로
  끝날 수 있고, 트랜잭션 밖 쿼리는 다른 요청의 열린 트랜잭션에 섞여 그 롤백과 함께 사라질 수 있다. `sourceRevision`
  비교와 캡처의 원자성은 동시 요청에 대해 보장하지 않는다. 이번 변경 이전부터의 SQLite 드라이버 공통 한계이며 이 ADR
  범위에서 해결하지 않는다. 동시성은 PostgreSQL 통합 테스트로만 검증했다.
- **ADR-0020 breaking change 기준**: 이 변경은 엔드포인트·필수 필드·응답 필드 제거나 개명·상태 코드 의미·인증 방식을 바꾸지
  않는다. `sourceRevision`은 선택 필드, `current`(`revision` 포함)는 412 body에 추가한 필드다(`ErrorResponse`는 추가 속성을 허용한다).
  최초 평가의 status·body는 그대로이고 같은 key 재시도의 결과만 재생으로 바뀐다. 영향받는 endpoint는 모두
  `[Unreleased]`에서 추가돼 릴리즈된 계약에 없다. 따라서 `/api/v2` 교체 대상이 아니며 `CHANGELOG.md`에서
  `**BREAKING**:` 접두사(`docs/adr/0007-semver-release-versioning-package-json-inert.md`)를 붙이지 않고 `Changed`에 재시도 동작 변경을 명시한다.
