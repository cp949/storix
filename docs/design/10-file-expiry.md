# FILE 만료와 확정

Storix는 호출자가 새 FILE을 만들 때 수명을 지정하게 하고, 사용을 확정한 FILE은 `persist`로 만료를 해제한다. 확정되지 않은 FILE은 만료 시각 이후 GC가 namespace 삭제 정책에 따라 회수한다. 경로와 node ID는 확정 때 바뀌지 않는다. Blob은 경로·snapshot 사이에 공유되므로 객체 저장소의 lifecycle은 이 계약을 대신하지 않는다.

## 데이터 모델과 설정

- `vfs_node.expires_at`은 nullable timestamp다. NULL은 만료 없음이며 FILE만 값을 가질 수 있다. DIRECTORY는 항상 NULL이다. `(expires_at) WHERE expires_at IS NOT NULL` 부분 인덱스로 GC 후보를 조회한다.
- PostgreSQL과 SQLite의 기존 node는 migration 뒤 NULL이다. Migration `down`은 컬럼과 인덱스를 제거하므로 남아 있는 미확정 FILE은 영구 파일이 된다.
- 입력 초는 양의 안전 정수이며 `STORIX_VFS_EXPIRY_MIN_SECONDS`(기본 60) 이상, `STORIX_VFS_EXPIRY_MAX_SECONDS`(기본 2592000) 이하다. 최대 설정값은 PostgreSQL INTEGER 컬럼의 상한 2147483647초다. 설정이 유효하지 않거나 MIN이 MAX보다 크면 부팅을 거부한다. 입력 검사 규칙은 `file-expiry-policy.ts`에 있다.
- 만료 시각은 FILE 생성 또는 재개 업로드 완료 커밋 transaction의 DB 시각 + 입력 초다. `expires_at`은 삭제 가능 시각이며 GC가 삭제하기 전까지는 FILE로 조회·변경·확정할 수 있다.

## 생성 입력

| 요청                           | 만료 입력                                     | 필요한 조건               |
| ------------------------------ | --------------------------------------------- | ------------------------- |
| `POST /fs/content/conditional` | `X-Expires-In` 헤더, 선행 0 없는 10진 정수 초 | `X-If-Absent: true`       |
| `POST /fs/upload-sessions`     | JSON integer `expiresInSeconds`               | `ifAbsent: true`          |
| `POST /fs/mutations`의 `copy`  | JSON integer `expiresInSeconds`               | `destinationAbsent: true` |

`ConditionalContentService`는 잘못된 헤더 형식·범위·조건 조합을 본문 소비와 receipt 생성 전에 400 `VFS_INVALID_EXPIRY`로 거부한다. 유효한 값은 receipt fingerprint에 포함한다. 같은 key로 만료 값만 바꾸면 409 `MUTATION_KEY_REUSED`다.

재개 업로드는 생성 시 값을 검사해 세션에 고정한다. 완료 때 범위를 다시 검사하지 않고 완료 커밋의 DB 시각을 기준으로 FILE 만료를 계산한다. 세션 생성 fingerprint에 값이 포함된다. 세션 자체의 `expiresAt`과 FILE의 만료는 서로 다른 수명이다. 세션 상태의 `condition.expiresInSeconds`에 FILE 만료 입력이 나타난다.

조건부 copy는 새로 생기는 모든 FILE에 복사 transaction의 같은 DB 시각을 기준으로 만료를 적용한다. 새 DIRECTORY는 만료되지 않는다. 값을 생략하면 원본 만료와 관계없이 새 FILE의 만료는 NULL이다. `move`에 `expiresInSeconds`를 보내면 400 `VFS_INVALID_EXPIRY`다. 조건부 변경의 만료 입력 오류는 기존 파싱 오류 receipt 규칙에 따라 저장·재생된다.

레거시 `POST /fs/cp`는 `expiresInSeconds`를 거부하고, `POST /fs/content`는 `X-Expires-In`을 거부한다. 두 경우 모두 400 `VFS_INVALID_EXPIRY`로 응답해 만료가 적용됐다는 오해를 막는다. 조건부 업로드에서 `X-If-Revision`과 만료를 함께 보낼 수 없다. 같은 규칙이 재개 업로드의 `ifRevision`에도 적용된다.

## 응답과 확정

`VfsNode.expiresAt`은 필수 nullable date-time 필드다. `VfsStat`, 노드 목록, 조건부 변경 결과와 업로드 결과는 이를 공유한다. DIRECTORY와 만료 없는 FILE에는 null을 반환한다. 이전 버전의 receipt 재생 응답에는 필드가 없을 수 있다.

`POST /fs/mutations`의 `persist` 요청은 `{ "kind": "persist", "path": "/a/b.bin", "ifRevision": "r1.…" }`다. `Idempotency-Key`와 `X-Mutation-Scope`가 필요하고 `ifRevision` 누락은 428이다. 일반 조건부 변경의 receipt 저장·재생과 감사 규칙을 사용한다.

`VfsNodeRepository`는 namespace root 잠금 아래 부모 체인과 대상을 잠근다. 대상이 없으면 404 `VFS_NODE_NOT_FOUND`, DIRECTORY면 409 `VFS_IS_DIRECTORY`, revision이 다르면 412 `VFS_PRECONDITION_FAILED`와 `current`를 반환한다. revision이 맞고 `expires_at`이 있으면 NULL로 바꾸고 version을 1 올리며 `updated_at`과 change feed `updated`를 기록한다. 결과는 200과 새 revision을 담은 `affectedRevisions`다. 이미 NULL이면 변경 없이 200, 빈 `affectedRevisions`, 같은 revision을 반환한다. quota와 Blob 참조는 변하지 않는다.

만료 시각이 지났더라도 GC가 삭제하기 전이면 확정할 수 있다. 같은 key의 재시도는 첫 200 receipt를 재생한다. 성공 응답을 잃고 새 key로 재시도해 412가 나오면 `current.id`가 같은 FILE이고 `current.expiresAt`이 null인지 확인해 확정 완료를 판정한다.

## GC 삭제와 경합

`GcJob.run()`은 업로드 세션 정리 뒤, orphan object 수집 전에 만료 FILE을 처리한다. `VfsFileExpiryRepository.expireDue`는 ACTIVE namespace의 `expires_at <=` 조회 시작 시점 DB now인 FILE을 `(expires_at, id)` keyset 순서로 500개씩 조회한다. 건너뛴 후보가 있어도 cursor는 전진한다.

각 후보에 대해 `VfsNodeRepository.expireNode`는 별도 transaction에서 namespace root를 잠그고 node ID의 현재 경로를 다시 해석한다. 부모 체인과 대상을 잠근 뒤 ID와 만료 조건을 재검사한다. 대상이 없어졌거나 확정됐으면 건너뛰고, 여전히 만료됐으면 기존 `moveToTrash` 삭제 경로를 사용한다. `trash_enabled`가 켜졌으면 휴지통 manifest를 만들고, 꺼졌으면 즉시 삭제한다. 기존 live quota·Blob 참조·change feed `deleted` 처리를 따른다. GC는 receipt와 감사 로그를 남기지 않는다. 항목 실패를 기록하고 다음 후보로 진행하며 다음 실행에서 재시도한다. `GcResult`는 `expiredFiles`와 `expiredBytes`를 집계한다.

확정, 이동, 삭제와 GC는 같은 namespace root 잠금으로 직렬화된다. 확정이 먼저 커밋되면 GC는 잠금 아래 재검사에서 건너뛴다. GC가 먼저 커밋되면 확정은 404다. 만료 삭제로 참조가 0이 된 Blob은 `zero_since`가 설정되고 orphan grace 이후 기존 수집 과정에서 회수된다.

실제 삭제 시점은 GC 실행 주기에 의존한다. cron과 `STORIX_GC_MIN_INTERVAL`(기본 3600초)을 고려해야 하며 GC를 실행하지 않으면 삭제되지 않는다.

## 다른 연산과 조회

| 연산                                                                                        | 만료 처리                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 파일·디렉터리 `mv`, 조건부 move                                                             | 같은 node이므로 유지                                                                   |
| 본문 덮어쓰기, 조건부 revision 업로드, 기존 FILE로 snapshot 복원, 재개 업로드 revision 완료 | 같은 node이므로 유지                                                                   |
| 조건부 mimeType 변경(setMimeType)                                                           | 같은 node이므로 유지                                                                   |
| 파일·디렉터리 `cp`, 조건부 copy                                                             | 새 FILE은 명시된 만료 입력만 적용하고 원본의 만료는 상속하지 않음. 새 DIRECTORY는 NULL |
| FILE·TREE snapshot 생성                                                                     | manifest에 만료를 저장하지 않음. 원본 만료 삭제 후에도 Blob 참조 유지                  |
| snapshot 복원으로 새 node 생성, 휴지통 복원                                                 | 만료 없음. 휴지통 manifest에도 만료를 저장하지 않음                                    |
| 호출자 `rm`, 재귀 `rmdir`                                                                   | 일반 삭제 계약 적용                                                                    |

인증 `stat`, `ls`, `find`, `exists`, `content`, `download`, presigned download는 만료 예정 FILE을 일반 FILE로 취급한다. 공개 `/api/v2/public/{namespaceId}/fs/content`와 `/download`는 만료 예정 FILE을 404 `VFS_NODE_NOT_FOUND`로 숨긴다. 생성·확정·GC 삭제는 각각 change feed의 `created`·`updated`·`deleted`로 나타나며 feed 항목에는 `expiresAt`을 추가하지 않는다.

만료 예정 FILE 바이트는 live quota에 포함한다. GC 삭제 커밋 때 휴지통이 꺼졌으면 해제되고, 켜졌으면 휴지통 quota로 이동한다.
