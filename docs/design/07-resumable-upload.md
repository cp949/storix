# 재개 가능한 업로드 세션

## 공개 계약

아래 세션·receipt·보존 계약은 ACTIVE namespace에 적용한다. namespace 관리자 삭제의 접근 차단과 세션 정리는 [namespace 삭제 설계](./13-namespace-deletion.md)의 "접근과 이름 재사용"·"UPLOADS"·"METADATA"를 따른다.

`resumable-upload`는 namespace 선택 capability이며 기본 비활성이다. 새 세션과 조각을 받으려면 다음 조건을 모두 충족해야 한다:

- capability를 전역에서 허용한다.
- namespace 항목 또는 기본 활성 목록에서 capability를 활성화한다.
- 유한한 전역 세션 정책을 제공한다.

서비스 Bearer key가 모든 요청을 인증하며 최종 사용자 권한은 호출 서버가 판단한다. 기능을 끈 뒤에도 같은 생성 key의 응답 재생, 기존 세션의 조회·취소·정리, 모든 조각이 저장된 세션의 완료는 가능하다.

`POST /api/v2/namespaces/{namespaceId}/fs/upload-sessions` 입력:

- `Idempotency-Key`: UUID다.
- `X-Mutation-Scope`: 비어 있지 않고 전송된 헤더 기준 최대 128 byte다.
- JSON: `{path,sizeBytes,mimeType,ifAbsent:true,sha256?}` 또는 `{path,sizeBytes,mimeType,ifRevision:"r1.…",sha256?}`다.

생성·재생 규칙:

- `sizeBytes`는 0도 허용하는 10진 문자열이다.
- 새 세션은 기존 파일 크기 상한을 먼저 검사한다. 그 뒤 파일 크기를 전역·namespace `maxStagedBytes` 중 작은 값과 비교한다.
- staging 상한을 넘으면 `413 VFS_UPLOAD_STAGING_FILE_TOO_LARGE`로 거부한다. 이 검사는 세션·creation key·사용량을 저장하지 않는다.
- 같은 creation key의 기존 요청은 현재 정책 검사보다 먼저 재생한다. 거절된 요청은 key를 점유하지 않으므로 정책을 높인 뒤 같은 요청과 key로 재평가할 수 있다.
- 생성 성공은 staging 공간 확보나 업로드 완료를 보장하지 않는다. 생성 시 누적 staging 사용량을 검사하거나 공간을 예약하지 않는다.
- staging 초과 413에는 `Retry-After`가 없다. 한도가 바뀌지 않으면 대기만으로 해결되지 않는다.
- 선택적 `sha256`은 저장 전 전체 평문 파일 바이트의 SHA-256을 정확히 64자리 소문자 hex로 쓴다.
- `ENCRYPTED` namespace도 평문 기준이다.
- 잘못된 값은 세션 생성 전에 `400 VFS_INVALID_CHECKSUM`으로 거부한다.
- 부모 디렉터리는 미리 존재해야 한다.
- 요청 조건은 생성 때와 완료 때 검사한다.
- 같은 namespace/scope/key와 같은 정규 경로·크기·소문자 MIME·조건·checksum을 재시도하면 최초 `201` 본문과 `X-Request-Id`를 재생한다.
- FAILED 후 같은 생성 key의 재시도도 최초 `201` 본문(`state: OPEN`)을 재생하고 현재 상태는 `GET`으로 조회한다.
- checksum 또는 바이트를 고친 업로드에는 새 key와 세션이 필요하다.
- 입력이나 checksum을 바꿔 기존 key로 보내면 `409 MUTATION_KEY_REUSED`다.
- 응답은 `sessionId`, `state: OPEN`, `partSizeBytes`, `partCount`, `expiresAt`, `maxExpiresAt`이다.
- 0 byte는 조각 없이 완료한다.

조각 저장:

- `PUT /{sessionId}/parts/{index}`는 `application/octet-stream`과 정확한 `Content-Length`를 요구한다.
- index는 0부터 시작한다.
- 마지막 조각 외에는 크기가 세션의 `partSizeBytes`와 같아야 한다.
- 성공은 `{index,sizeBytes,sha256,replayed,expiresAt}`이며 SHA-256은 평문 기준이다.
- `expiresAt`은 이 요청이 갱신한 세션 비활동 만료 시각이다. `min(now + inactivitySeconds, maxExpiresAt)`이며 저장소 계층이 트랜잭션에서 실제 반영한 값을 그대로 돌려준다. 정상 저장과 동일 조각 재전송 모두 포함한다.
- commit ACK를 잃은 PUT을 서버가 저장 확정으로 복구하면 `findStoredPartWithExpiry`가 한 조회로 읽은 세션 만료를 돌려준다. 다른 PUT이 그 사이 갱신했다면 원래 요청의 갱신값보다 늦을 수 있고, 최대 수명은 넘지 않는다.
- 같은 index·크기·내용을 다시 보내면 바이트를 검증하고 `replayed: true`로 응답한다.
- 다른 내용은 `409 VFS_UPLOAD_PART_CONFLICT`, 진행 중인 같은 index는 `409 VFS_UPLOAD_PART_IN_PROGRESS`다.
- 선택 요청 헤더 `X-Content-Sha256`은 이 조각 평문의 SHA-256(64자리 소문자 hex)이다. 암호화 namespace도 평문 기준이다.
  - 형식 검증은 `content/conditional`과 같은 `parseSha256Header`를 쓴다.
  - 형식 오류는 세션 조회와 본문 소비 전에 `400 VFS_INVALID_CHECKSUM`이다.
  - 판정 순서는 ① 헤더 ≠ 본문 해시 → `422 VFS_PART_CHECKSUM_MISMATCH`, ② 본문 해시 ≠ 저장된 조각 → `409 VFS_UPLOAD_PART_CONFLICT`, ③ 모두 일치 → 저장 또는 `replayed: true`다.
  - 재생 경로도 같은 순서다. 헤더 비교가 항상 먼저다.
  - 422는 조각을 저장하지 않는다. staging key를 `cleanupReservation`으로 지우고 예약량을 해제하며, 세션 비활동 만료를 갱신하지 않는다.
  - 422 뒤 같은 index를 올바른 내용으로 다시 보낼 수 있다. 저장된 조각은 교체할 수 없는 것(409)과 다르다.
  - 완료 시 전체 해시 불일치 `VFS_CHECKSUM_MISMATCH`와 코드가 다르다.
  - 한계: 본문을 먼저 해시한 뒤 저장하지 않는다. 스트리밍 구조라 불일치 요청은 staging PUT을 한 번 낭비한다.
  - 응답 메시지는 고정 문구이며 digest를 싣지 않는다.
  - 검증: `test/vfs/upload-session-part.service.spec.ts`, `test/vfs/upload-session-parts.integration-spec.ts`(PostgreSQL), `test/vfs/upload-session-parts.sqlite.integration-spec.ts`(SQLite).
- 조각별 digest와 생성 요청의 전체 파일 `sha256`은 별개다.

상태·완료·취소:

- `GET /{sessionId}`는 상태, 조건, 저장된 조각의 index·크기, 만료 시각, 완료 시 결과를 반환한다.
- checksum 불일치로 끝난 세션은 `state: FAILED`, `failure: {code: "VFS_CHECKSUM_MISMATCH"}`를 반환한다.
- staging key, digest, 암호화 IV, 기대·계산 checksum은 노출하지 않는다.
- `POST /{sessionId}/complete`는 모든 조각이 저장됐을 때만 완료하며 생성 시 고정한 조건을 다시 검사한다.
- 최초 완료는 파일 변경에 따라 `200` 또는 `201`과 `{resource,affectedRevisions}` 및 `X-Request-Id`를 반환한다.
- `resource.sha256`은 저장된 전체 평문 바이트의 SHA-256이며 반환한 revision의 콘텐츠와 같다. 값은 완료 결과·receipt에 응답과 함께 저장되어 재생 때 그대로 나온다. 이 필드가 생기기 전의 결과에는 없을 수 있고 현재 파일의 값으로 보충하지 않는다. `content/conditional`의 `resource`도 같다.
- 지정한 전체 checksum이 저장 전 평문 바이트와 다르면 파일·revision 변경 없이 `422 VFS_CHECKSUM_MISMATCH`로 `FAILED`에 종결하고 최초 오류 body와 `X-Request-Id`를 저장한다.
- 이후 완료는 최초 status, body, request ID를 재생한다.
- 진행 중 완료는 `409 VFS_UPLOAD_SESSION_IN_PROGRESS`, 빠진 조각은 `409 VFS_UPLOAD_PARTS_INCOMPLETE`다.
- `DELETE /{sessionId}`는 OPEN 세션을 취소하고 현재 세션 상태 본문을 반환한다.
- 만료 시각이 지난 OPEN 세션의 취소는 GC 전이라도 EXPIRED로 전환하고 `409 VFS_UPLOAD_SESSION_CLOSED`다. 조각 저장·완료와 같은 판정이다.
- `GET /{sessionId}`는 상태를 전환하지 않는다. GC 전환 전의 만료 세션은 `state: OPEN`과 지난 만료 시각을 함께 반환한다.
- `state: OPEN`이고 조회 처리 중 한 번 잡은 서버 시각이 `expiresAt` 또는 `maxExpiresAt` 이상이면 파생 필드 `expired: true`가 붙는다. 그 밖에는 필드가 없다. 호출자 시계와 무관한 판정이다.
- 반복 취소는 같은 종결 상태를 반환한다.
- 완료·취소·만료·실패 중 다른 종결 상태로의 전이는 `409 VFS_UPLOAD_SESSION_CLOSED`다.
- 없는 세션과 다른 namespace의 세션은 `404 VFS_UPLOAD_SESSION_NOT_FOUND`다.
- 상태·취소에는 capability gate가 없다.

정책 변경과 staging 진단:

- 기존 세션의 `partSizeBytes`·`partCount`는 생성 당시 값으로 유지한다.
- 새 조각 예약에는 현재 전역·namespace staging 한도 중 작은 값을 적용한다.
- 한도 하향은 이미 확보한 예약과 저장된 조각을 취소하거나 차감하지 않는다.
- 저장된 조각의 동일 내용 재전송은 현재 staging 한도와 무관하게 처리한다.
- 모든 조각이 저장된 세션의 완료는 staging 한도 초과만으로 거부하지 않는다.
- GET은 OPEN이며 만료되지 않았고 정책이 있을 때 `staging`을 반환한다. capability 상태와 무관하다.
- `staging.maxStagedBytes`는 현재 적용 한도의 10진 문자열이다.
- `staging.status`는 `PARTS_STORED`, `PARTS_IN_PROGRESS`, `FILE_TOO_LARGE`, `WITHIN_LIMIT` 중 하나다.
- 조각 상태와 세션은 한 DB statement snapshot으로 읽는다. GET은 세션 상태·만료·사용량을 바꾸지 않는다.
- 저장 완료된 모든 index가 있으면 `PARTS_STORED`다. 그 다음 누락 index 모두에 유효 lease가 있으면 `PARTS_IN_PROGRESS`다.
- 그 밖에 전체 파일 크기가 현재 한도를 넘으면 `FILE_TOO_LARGE`다. 나머지는 `WITHIN_LIMIT`다.
- `PARTS_IN_PROGRESS`는 저장 성공을 보장하지 않는다. 만료된 lease는 worker 종료 증거가 아니다.
- `WITHIN_LIMIT`은 공간 확보·quota admission·PUT·완료 성공을 보장하지 않는다.
- 실제 새 예약 직전 전체 파일 크기가 한도를 넘으면 `413 VFS_UPLOAD_STAGING_FILE_TOO_LARGE`다.
- 전체 파일 크기는 한도 이하지만 현재 사용량이 부족하면 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`다.
- 두 오류에는 `Retry-After`가 없다. 한도 변경 뒤 같은 세션과 index로 재평가한다.
- staging 한도를 유지하려면 기존 세션을 취소하고 허용 가능한 파일 크기로 새 세션을 만든다. 취소는 객체 삭제 전 공간 반환을 보장하지 않는다.
- 정책 파일 변경은 서버 재시작 뒤 적용한다. 새 조각 크기만 줄여도 전체 파일이 staging 한도를 넘는 문제는 해결되지 않는다.
- 기존 세션의 `maxExpiresAt`는 생성 당시 값으로 고정한다. PUT 성공·동일 조각 재전송의 비활동 만료 갱신에는 현재 `inactivitySeconds`를 적용한다.
- capability 비활성·세션 정책 제거는 PUT을 막는다. GET·취소·complete는 현재 capability·세션 정책을 재검사하지 않는다.
- complete의 경로 조건과 namespace 논리 quota는 완료 시점에 검사한다.

## 설정과 만료

- `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`의 UTF-8 JSON은 `global`과 `namespaces`만 허용한다.
- 같은 JSON 객체 안의 중복 key(같은 namespace ID를 두 번 적은 경우 포함)는 시작 오류다.
- `global`에는 양수 `maxStagedBytes`(10진 문자열, signed int64 이하), 양의 안전한 정수 `maxActiveSessions`가 필수다.
- `partSizeBytes`(기본 16777216, 최대 2147483647), `inactivitySeconds`(기본 86400), `maxLifetimeSeconds`(기본 604800)는 선택 양의 안전한 정수다.
- 비활동 기간은 최대 수명 이하여야 한다.
- `namespaces`는 선택 override다.
- namespace ID 키별로 필수 `maxStagedBytes`와 `maxActiveSessions`를 갖고 각각 전역 상한 이하여야 한다.
- namespace 항목은 선택 `partSizeBytes`(양의 안전한 정수, 최대 2147483647)를 가질 수 있다. 전역 `partSizeBytes`보다 커도 되고, 없으면 전역 값을 쓴다. `partSizeBytes`만 있는 항목은 시작 오류다.
- 전역 유효 `partSizeBytes`는 `global.maxStagedBytes` 이하여야 한다. namespace 유효 `partSizeBytes`는 해당 항목의 `maxStagedBytes` 이하여야 한다. 비교는 `BigInt(partSizeBytes) > maxStagedBytes`로 한다.
- 기본 조각 크기와 namespace 상속값도 검사한다. 설정 파일에 명시한 namespace는 capability 비활성 여부와 관계없이 검사한다. 값이 같으면 허용한다.
- 초과 설정은 시작 오류다. 오류에는 정책 파일 경로, scope, 유효 조각 크기와 staging 한도, 조각 크기의 기본값·상속 출처를 표시한다.
- 조각 크기를 staging 한도 이하로 낮추거나 staging 한도를 정책에 맞게 높여야 한다. 이 검사는 업로드 완료 가능성을 보장하지 않는다.
- 새 세션의 조각 크기는 `resolveNamespaceUploadPartSize`가 정하고 생성 시점 값으로 세션에 고정한다. 정책을 바꿔도 기존 세션의 `partSizeBytes`·`partCount`는 바뀌지 않으며 같은 생성 key의 재생도 저장된 값을 돌려준다.
- namespace 항목이 없으면 그 namespace에는 전역 `maxStagedBytes`·`maxActiveSessions`를 쓴다.
- 신규 namespace를 기본 활성 목록으로 켜는 배포가 namespace마다 항목을 만들지 않도록 한 규칙이다.
- 두 업로드 서비스는 `resolveNamespaceUploadLimits`로 같은 판정을 쓴다.
- 잘못된 Namespace ID, 알 수 없는 필드, 잘못된 값은 시작 오류다.
- 설정은 프로세스 시작 때 읽고 자동 reload하지 않는다.

정책·사용량 조회:

- `GET /api/v2/namespaces/{id}`는 선택 블록 `uploadSessions`를 돌려준다. 전역 서비스 key로 읽는다.
- 블록은 `NamespaceUploadSessionsReader`가 만든다. 컨트롤러 `findOne`이 `NamespaceService.findById` 결과에 합친다. create·list·관리자 PATCH 응답과 receipt 재생 본문에는 없다.
- 필드와 값은 다음과 같다.

| 필드                                      | 값                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `partSizeBytes`                           | 새 세션에 적용할 조각 크기. `resolveNamespaceUploadPartSize`가 정한다 |
| `inactivitySeconds`, `maxLifetimeSeconds` | 전역 값. namespace override가 없다                                    |
| `maxStagedBytes`, `maxActiveSessions`     | `resolveNamespaceUploadLimits`가 정한 namespace 값 또는 전역 값       |
| `stagedBytes`, `activeSessions`           | `readNamespaceUsage`가 읽은 `vfs_upload_usage` 값                     |

- 바이트 한도·사용량(`maxStagedBytes`, `stagedBytes`)은 int64 문자열이다. 조각 크기·초·개수는 정수다.
- 다음 중 하나면 블록을 생략하고 사용량을 읽지 않는다.
  - namespace가 `ACTIVE`가 아니다.
  - `resumable-upload`가 비활성이다. 비활성 namespace에 남은 세션의 사용량은 이 조회로 알 수 없다.
  - 업로드 세션 정책이 없다.
- `stagedBytes`는 정착하지 않은 예약량과 정착한 조각을 구분하지 않는다.
- 사용량은 호출 시점 읽기이고 admission 판정이 아니다. 블록을 읽은 뒤에도 조각 PUT이 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`를 받을 수 있다.
- 검증: `test/namespace/namespace-upload-sessions.reader.spec.ts`, `test/namespace/namespace.controller.spec.ts`, `test/vfs/upload-session-parts.integration-spec.ts`(PostgreSQL), `test/vfs/upload-session-parts.sqlite.integration-spec.ts`(SQLite).

세션 수명과 요청 한도:

- 세션 생성 시 조각 크기와 생성 시각 기준 최대 만료 시각을 고정한다.
- 조각 저장·동일 조각 재시도의 활동은 비활동 만료를 갱신하되 최대 수명을 넘지 못한다.
- 만료된 OPEN은 GC에서 EXPIRED로 전환하고, 만료된 FINALIZING lease는 OPEN으로 복구한다.
- 완료·취소·만료·실패 세션은 활성 세션 한도에서 즉시 빠진다.
- 종결 세션과 완료·실패 응답은 종결 시점부터 최소 30일 보존하며, 그 뒤에도 모든 조각의 삭제를 확인해야 제거한다.
- 생성 크기는 namespace의 적용 `maxFileSizeBytes`와 전역 `STORIX_MAX_FILE_SIZE_BYTES`(기본 5 GiB) 중 낮은 값을 따른다.
- 생성 JSON에는 기존 16 KiB 본문 한도가 적용되고 조각 요청의 지속 시간은 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`(기본 86400초)로 제한한다.

## 저장과 공개

- 각 조각 예약 시 새 UUID `upload-staging/<uuid>` key를 만든다.
- 실패·삭제된 part index를 다시 시도해도 이전 key를 재사용하지 않는다.
- DB에서 전역·namespace 임시 바이트와 활성 세션 수를 잠금 하에 검사한다.
- 조각 객체와 진행 중 예약 바이트는 실제 삭제가 확인될 때까지 임시 사용량에 남는다.
- 임시 바이트 한도는 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`, 활성 세션 수 한도는 `429 VFS_UPLOAD_SESSION_LIMIT_EXCEEDED`와 `Retry-After: 1`이다.

암호화와 검증:

- 암호화 namespace의 staging은 master key로 암호화하고 IV를 내부 metadata에 저장한다.
- 완료는 조각을 순서대로 읽고 크기·평문 SHA-256을 다시 검사한다.
- `ENCRYPTED` namespace에서는 기존 `EncryptingPutTarget`으로 최종 Blob을 새로 암호화하면서 전체 평문 SHA-256을 계산한다.
- 업로드 뒤 세션의 지정값과 비교하고, 일치할 때만 파일 변경 트랜잭션에 진입한다.
- 일반 namespace는 평문 스트림을 사용한다.
- staging은 Node/Blob 참조를 만들지 않으며 공개 VFS 경로에서 읽을 수 없다.

완료의 원자성:

- 완료 작업자는 OPEN → FINALIZING을 claim하고 lease token을 받는다.
- 스트리밍 중 heartbeat가 token과 미만료 lease를 갱신한다.
- 최종 Blob 저장 뒤에도 갱신하며, `VfsNodeRepository.withMutation` 안에서 token·lease를 다시 검증한다.
- 해당 트랜잭션은 조건부 경로 검사, 논리 quota, Node/Blob/revision, 사용량과 완료 결과를 함께 커밋한다.
- checksum 불일치는 공개 파일을 만들지 않고 FAILED 상태·422 완료 결과·활성 세션 수 감소를 한 DB transaction에서 확정한다.
- 그 밖의 실패한 완료는 공개 파일을 만들지 않고 소유한 claim만 OPEN으로 돌린다.
- OPEN 복귀와 같은 UPDATE가 마지막 실패의 `{code, at}`을 세션에 저장한다. `code`는 HTTP 오류 응답과 같은 규칙으로 정하며 분류되지 않은 서버 오류는 `INTERNAL_ERROR`다. `at`은 오류 처리에 들어간 서버 시각이다. 예외 메시지와 내부 저장소 정보는 저장하지 않는다.
- token이 일치할 때만 저장하므로 회수된 이전 작업자의 늦은 실패는 새 claim의 상태를 덮지 못한다.
- 실패 정보는 `GET /{sessionId}`의 `lastCompleteFailure`로 `OPEN` 상태에서만 노출한다. 다음 claim 획득과 완료·취소·만료·FAILED 종결 전이가 지우고, 조각 저장·재전송과 조회는 지우지 않는다.
- 기록은 best effort다. 저장 실패나 프로세스 종료에는 필드가 없을 수 있다. 필드 부재는 성공을 뜻하지 않으며, stale lease 회수는 실패 코드를 추정해 만들지 않는다.
- 커밋 결과가 불확실한 경우 참조 가능성이 있는 최종 객체는 보존하여 orphan GC에 맡긴다.
- 늦은 작업자는 회수된 claim으로 공개할 수 없다.
- 취소는 OPEN만 claim하므로 완료와 취소 중 한 종결 상태만 이긴다.

조각 정리:

- 완료·취소·만료된 세션의 조각은 종결 시점에 삭제하지 않는다.
- GC가 삭제하며 그 전까지 조각 바이트는 임시 사용량에 남는다.
- GC를 실행하지 않으면 이 사용량이 `maxStagedBytes`를 채워 새 조각 예약이 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`가 될 수 있다.
- checksum 불일치로 실패한 세션은 즉시 조각 삭제를 시작한다.
- 삭제 실패 시 GC가 재시도하며, 실제 삭제 확인 전 조각 바이트는 임시 사용량에 남는다.
- GC는 DB의 활성 staging key를 orphan 검사에 포함해 보호하고, 종결 세션의 조각 삭제 실패를 재시도한다.
- metadata가 없는 `upload-staging/` 객체에는 기존 orphan grace를 적용한다.

PUT 정착과 예약량 해제:

- 조각 예약에는 PUT 소유 lease를 두고 PUT가 진행되는 동안 갱신한다.
- 만료된 `RESERVED`는 key별 정리 기록으로 옮기고 이전 key의 예약량을 전역·namespace 상한에 계속 포함한다.
- 이전 PUT가 미정착인 동안 같은 index를 재시도하면 다음 규칙을 적용한다.
  - 정리 중이면 `409 VFS_UPLOAD_PART_IN_PROGRESS`다.
  - 삭제 후에도 이전 예약량으로 cap이 찼으면 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`다.
- 용량 여유가 있으면 새 UUID key로 재시도할 수 있다.
- 정확한 key 삭제와 PUT 종료를 모두 확인한 뒤에만 이전 예약량을 해제한다.
- S3 SDK는 프로세스 중단된 PUT의 취소·정착을 증명하지 못하므로 이런 예약은 자동으로 과금을 해제하지 않는다.
- 같은 세션 또는 다른 업로드가 cap에 막힐 수 있다.
- 이 경우 자동 복구 경로는 없다.
- GC는 key를 반복 정리하지만 과금 해제 근거는 만들지 않는다.
- 이 정리에는 GC 잡 실행이 필요하다.

온라인 PUT와 multipart GC 소유권은 [api ADR-0045](../../apps/api/docs/adr/0045-gc-incomplete-multipart-upload.md)를 따른다.
part lease 만료는 storage worker 종료 근거가 아니다.
GC는 `key + uploadId` abort 뒤에도 staging 예약량을 정산하지 않는다.

## 검증과 운영 경계

검증 코드와 재현 절차:

- `apps/api/test/vfs/upload-session.service.spec.ts`: 세션 생성·조회·취소.
- `apps/api/test/vfs/upload-session-part.service.spec.ts`: 조각 저장.
- `apps/api/test/vfs/upload-session-finalize.service.spec.ts`: 완료 처리.
- `apps/api/test/vfs/upload-session-finalize.shared-tests.ts`: PostgreSQL·SQLite 완료 계약과 checksum 검증.
- `apps/demo1/was/src/document-archive/upload-sessions.controller.spec.ts`: WAS의 세션 API.
- `docs/deployment/scenarios/demo-all-in-one/`: PostgreSQL·VersityGW 기반 PRIVATE namespace의 재현 절차.

운영 활성화, 배포별 한도, GC 스케줄과 여러 API instance의 배치 동작은 별도 검증 대상이다.
`ENCRYPTED` namespace, 브라우저별 재개 동작과 조각 PUT 중 프로세스 중단도 별도로 검증한다.
multipart/form-data, presigned part URL과 최종 사용자별 ACL은 이 계약 범위 밖이다.
