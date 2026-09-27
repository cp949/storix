# 재개 가능한 업로드 세션

## 공개 계약

`resumable-upload`는 namespace 선택 capability이며 기본 비활성이다. 전역과 해당 namespace에서 허용하고 유한한 세션 정책을 제공해야 새 세션과 조각을 받을 수 있다. 서비스 Bearer key가 모든 요청을 인증하며 최종 사용자 권한은 호출 서버가 판단한다. 기능을 끈 뒤에도 같은 생성 key의 응답 재생, 기존 세션의 조회·취소·정리, 모든 조각이 저장된 세션의 완료는 가능하다.

`POST /api/v2/namespaces/{namespaceId}/fs/upload-sessions`는 UUID `Idempotency-Key`, 최대 128 UTF-8 bytes의 비어 있지 않은 `X-Mutation-Scope`와 JSON `{path,sizeBytes,mimeType,ifAbsent:true}` 또는 `{path,sizeBytes,mimeType,ifRevision:"r1.…"}`를 받는다. `sizeBytes`는 0도 허용하는 10진 문자열이다. 부모 디렉터리는 미리 존재해야 한다. 요청 조건은 생성 때와 완료 때 검사한다. 같은 namespace/scope/key와 같은 정규 경로·크기·소문자 MIME·조건을 재시도하면 최초 `201` 본문과 `X-Request-Id`를 재생한다. 입력을 바꾸면 `409 MUTATION_KEY_REUSED`다. 응답은 `sessionId`, `state: OPEN`, `partSizeBytes`, `partCount`, `expiresAt`, `maxExpiresAt`이다. 0 byte는 조각 없이 완료한다.

`PUT /{sessionId}/parts/{index}`는 `application/octet-stream`과 정확한 `Content-Length`를 요구한다. index는 0부터 시작하고 마지막 조각 외에는 세션의 `partSizeBytes`와 크기가 같아야 한다. 성공은 `{index,sizeBytes,sha256,replayed}`이며 SHA-256은 평문 기준이다. 같은 index·크기·내용을 다시 보내면 바이트를 검증하고 `replayed: true`로 응답한다. 다른 내용은 `409 VFS_UPLOAD_PART_CONFLICT`, 진행 중인 같은 index는 `409 VFS_UPLOAD_PART_IN_PROGRESS`다. 파일 전체에 대해 호출자가 지정한 checksum을 검증하는 API는 없다.

`GET /{sessionId}`는 상태, 조건, 저장된 조각의 index·크기, 만료 시각, 완료 시 결과를 반환한다. staging key, digest, 암호화 IV는 노출하지 않는다. `POST /{sessionId}/complete`는 모든 조각이 저장됐을 때만 완료하며 생성 시 고정한 조건을 다시 검사한다. 최초 완료는 파일 변경에 따라 `200` 또는 `201`과 `{resource,affectedRevisions}` 및 `X-Request-Id`를 반환한다. 이후 완료는 최초 status, body, request ID를 재생한다. 진행 중 완료는 `409 VFS_UPLOAD_SESSION_IN_PROGRESS`, 빠진 조각은 `409 VFS_UPLOAD_PARTS_INCOMPLETE`다. `DELETE /{sessionId}`는 OPEN 세션을 취소하고 현재 세션 상태 본문을 반환한다. 반복 취소는 같은 종결 상태를 반환한다. 완료·취소·만료 중 다른 종결 상태로의 전이는 `409 VFS_UPLOAD_SESSION_CLOSED`다. 없는 세션과 다른 namespace의 세션은 `404 VFS_UPLOAD_SESSION_NOT_FOUND`다. 상태·취소에는 capability gate가 없다.

## 설정과 만료

`STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`의 UTF-8 JSON은 `global`과 `namespaces`만 허용한다. `global`에는 양수 `maxStagedBytes`(10진 문자열, signed int64 이하), 양의 안전한 정수 `maxActiveSessions`가 필수다. `partSizeBytes`(기본 16777216, 최대 2147483647), `inactivitySeconds`(기본 86400), `maxLifetimeSeconds`(기본 604800)는 선택 양의 안전한 정수다. 비활동 기간은 최대 수명 이하여야 한다. `namespaces`는 UUID 키별로 필수 `maxStagedBytes`와 `maxActiveSessions`를 갖고 각각 전역 상한 이하여야 한다. 정규화한 UUID 중복, 알 수 없는 필드, 잘못된 값, 활성 namespace의 누락된 정책은 시작 오류다. 설정은 프로세스 시작 때 읽고 자동 reload하지 않는다.

세션 생성 시 조각 크기와 생성 시각 기준 최대 만료 시각을 고정한다. 조각 저장·동일 조각 재시도의 활동은 비활동 만료를 갱신하되 최대 수명을 넘지 못한다. 만료된 OPEN은 GC에서 EXPIRED로 전환하고, 만료된 FINALIZING lease는 OPEN으로 복구한다. 완료·취소·만료 세션은 활성 세션 한도에서 즉시 빠진다. 종결 세션과 완료 응답은 30일 보존한 뒤, 조각이 모두 삭제된 경우에만 제거한다. 생성 크기는 namespace의 적용 `maxFileSizeBytes`와 전역 `STORIX_MAX_FILE_SIZE_BYTES`(기본 5 GiB) 중 낮은 값을 따른다. 생성 JSON에는 기존 16 KiB 본문 한도가 적용되고 조각 요청의 지속 시간은 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`(기본 86400초)로 제한한다.

## 저장과 공개

각 조각 예약 시 새 UUID `upload-staging/<uuid>` key를 만든다. 실패·삭제된 part index를 다시 시도해도 이전 key를 재사용하지 않는다. DB에서 전역·namespace 임시 바이트와 활성 세션 수를 잠금 하에 검사한다. 조각 객체와 진행 중 예약 바이트는 실제 삭제가 확인될 때까지 임시 사용량에 남는다. 임시 바이트 한도는 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`, 활성 세션 수 한도는 `429 VFS_UPLOAD_SESSION_LIMIT_EXCEEDED`와 `Retry-After: 1`이다.

암호화 namespace의 staging은 master key로 암호화하고 IV를 내부 metadata에 저장한다. 완료는 조각을 순서대로 읽고 크기·평문 SHA-256을 다시 검사하며, 기존 `EncryptingPutTarget`으로 최종 Blob을 새로 암호화한다. 일반 namespace는 평문 스트림을 사용한다. staging은 Node/Blob 참조를 만들지 않으며 공개 VFS 경로에서 읽을 수 없다.

완료 작업자는 OPEN → FINALIZING을 claim하고 lease token을 받는다. 스트리밍 중 heartbeat가 token과 미만료 lease를 갱신한다. 최종 Blob 저장 뒤에도 갱신하며, `VfsNodeRepository.withMutation` 안에서 token·lease를 다시 검증한다. 해당 트랜잭션은 조건부 경로 검사, 논리 quota, Node/Blob/revision, 사용량과 완료 결과를 함께 커밋한다. 실패한 완료는 공개 파일을 만들지 않고 소유한 claim만 OPEN으로 돌린다. 커밋 결과가 불확실한 경우 참조 가능성이 있는 최종 객체는 보존하여 orphan GC에 맡긴다. 늦은 작업자는 회수된 claim으로 공개할 수 없다. 취소는 OPEN만 claim하므로 완료와 취소 중 한 종결 상태만 이긴다.

GC는 DB의 활성 staging key를 orphan 검사에 포함해 보호하고, 종결 세션의 조각 삭제 실패를 재시도한다. metadata가 없는 `upload-staging/` 객체에는 기존 orphan grace를 적용한다. 실제 객체 삭제 전에는 예약·사용량을 해제하지 않는다. 이 정리에는 GC 잡 실행이 필요하다.

## 검증과 운영 경계

코드와 로컬 단위·PostgreSQL/MinIO·SQLite 통합 검증은 계약 구현의 근거다. 이 검증은 운영 환경에서 capability를 실제 활성화했다는 것, 배포별 한도 선택, 배포 GC 스케줄, 여러 API instance의 실제 배치 동작 또는 실사용 소비자와의 호환성을 증명하지 않는다. 전체 파일 checksum, multipart/form-data, presigned part URL, 최종 사용자별 ACL은 이 계약 범위 밖이다.
