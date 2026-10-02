# Changelog

이 문서는 Storix(고객당 단일 인스턴스로 배포되는 `apps/api` 제품)의 주목할 만한
변경사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를
따른다. `[Unreleased]`를 버전 섹션으로 바꾸는 시점의 태그(`vX.Y.Z`)가 그 버전을
릴리즈한다(`docs/deployment/release.md`). `package.json` 버전과의 동기화 정책은
아직 없어(`API-03`) 이 문서의 버전 번호가 지금은 유일한 근거다.

## [Unreleased]

### Added

- 폴더별 직접 자식 `FILE` 수 상한을 추가했다. 기본값은 `STORIX_DEFAULT_MAX_FILES_PER_FOLDER=10000`이고 `STORIX_MAX_FILES_PER_FOLDER`가 전역 ceiling이다. migration `AddFolderFileCount1791700000018`은 기존 폴더 counter를 backfill하며, 초과 생성은 413 `VFS_FOLDER_FILE_LIMIT_EXCEEDED`로 거부한다.
- namespace의 root를 제외한 live `FILE`·`DIRECTORY` 수 상한을 추가했다. 기본값은 `STORIX_DEFAULT_MAX_LIVE_NODES=1000000`이고 `STORIX_MAX_LIVE_NODES`가 전역 ceiling이다. migration `AddLiveNodeCount1791700000019`가 기존 수를 backfill하며, 상한 초과 생성은 413 `VFS_NAMESPACE_NODE_LIMIT_EXCEEDED`로 거부한다. namespace 삭제 GC도 counter를 배치별 정산한다.

- Namespace 생성에서 `name`을 생략하거나 `null`로 지정할 수 있다. 응답의 `name`은 항상 존재하며 미지정이면 `null`이다. 목록은 이름 있는 항목을 `(name, id)` 순으로 반환하고 이름 없는 항목을 뒤에 `id` 순으로 반환한다. migration `MakeNamespaceNameNullable1791700000017`이 nullable 제약과 이름 없는 항목용 인덱스를 추가한다. 이름 없는 행이 있으면 migration down을 거부한다.
- Namespace ID 생성 시 선택 필드 `idPrefix`를 지원한다. ID는 기존 UUID 또는 `{prefix}_{UUID v4의 하이픈 제거 32자리}` 형식이다. capability·resumable upload namespace 설정도 새 형식을 받으며 대소문자·하이픈 변형은 별칭으로 취급하지 않는다. migration `ConvertNamespaceIdToString1791700000016`은 PostgreSQL namespace 참조 컬럼을 `varchar(45) COLLATE "C"`로 바꾸고 `vfs_upload_usage.id`를 `varchar(64)`로 확장한다. SQLite는 `varchar` 길이를 제한하지 않으므로 새 migration은 타입 변경이 없다. 새 ID가 만들어진 뒤 migration down은 UUID 형식이 아닌 참조가 남아 있으면 거부된다.
- `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`(기본 `30`): 삭제가 끝난(`DELETED`) namespace의 행을 gc가 물리 삭제하기까지의 보존 기간이다. 완료 시점부터 이 기간이 지나면 namespace·삭제 operation·삭제 receipt 행을 지운다(GC 결과 `purgedNamespaces`). 이후 `GET /api/v2/namespaces/{id}`·삭제 상태 조회·같은 key의 삭제 재요청은 404 `NAMESPACE_NOT_FOUND`다(보존 기간 안에서는 `DELETED` 상태 응답과 최초 202 재생). 물리 삭제는 되돌릴 수 없고 복구에는 삭제 전 백업이 필요하다. 설정(`STORIX_VFS_CAPABILITIES_CONFIG_PATH`)에 적은 namespace가 물리 삭제되면 시작이 거부되므로 삭제한 namespace는 설정에서 지운다. migration `AddNamespaceDeletionCompletedIndex1791700000015`(인덱스만 추가)가 필요하다. 결정은 api ADR-0035다.
- `GET /api/v2/namespaces`의 page 모드: `limit`(기본 100·최대 1000)·`cursor`를 주면 `{ items, nextCursor }`를 `(name, id)` 순서의 keyset으로 반환한다. 잘못된 cursor는 400 `VFS_INVALID_CURSOR`다. 100만 namespace에서 첫 page가 9ms, 전체 순회(page 1000개)가 11.5s·API RSS 416MiB다. 이전 계약의 전체 배열은 100만 개에서 응답 364MiB·9.8s·RSS 2.6GiB였다.
- capability 설정 파일의 선택 키 `defaultEnabledCapabilities`: `namespaceAllowedCapabilities`에 항목이 없는 모든 namespace(설정 이후 만든 namespace 포함)에 켤 capability 목록이다. 전역 허용이 최종 상한이고 namespace 항목이 있으면 그 값이 기본 목록을 대신한다(빈 목록은 비활성). 키가 없으면 이전 동작과 같다. 회원마다 namespace를 만드는 배포가 namespace를 설정에 나열하거나 재시작하지 않아도 된다.
- `STORIX_GC_MAX_ROWS_PER_STAGE`(기본 `200000`): GC가 한 실행에서 단계마다 처리하는 행 수 예산이다. 소진된 단계는 재개 위치를 `gc_cursor` 테이블에 저장하고 다음 실행이 이어간다. 대상 단계는 change feed 보존 정리, orphan object·blob 회수, 만료 session·staging 정리, 파일 만료 삭제, namespace 삭제 순회, receipt·휴지통 prune이다. GC 결과 JSON에 예산이 소진된 단계를 알리는 `budgetExhaustedStages`가 추가됐다.

### Deprecated

- `limit`·`cursor` 없이 호출하는 `GET /api/v2/namespaces`(ACTIVE 전체 배열). 동작은 그대로이고 개수에 상한이 없다. 새 호출자는 page 모드를 쓴다.

### Changed

- `STORIX_DEFAULT_TOTAL_LOGICAL_BYTES`·`STORIX_DEFAULT_FILE_SIZE_BYTES`와 `STORIX_MAX_TOTAL_LOGICAL_BYTES`·`STORIX_MAX_FILE_SIZE_BYTES`를 분리했다. MAX만 지정하면 이전처럼 기본값과 ceiling이 같고, DEFAULT만 지정하면 기본값 아래·위 namespace override를 허용하며 ceiling은 구조 상한으로 제한한다. 시작 시 DEFAULT가 ceiling을 넘거나 파일 크기 ceiling이 S3 multipart 구조 상한(16 MiB × 10,000 parts)을 넘으면 거부한다.

- namespace 생성(201·이름 충돌 409)과 관리 API(quota, trash 정책)의 `Idempotency-Key` receipt(`idempotency_key`)를 생성 시점부터 30일 보존한 뒤 GC가 지운다(GC 결과 `prunedIdempotencyReceipts`). 이전에는 영구 보존이었다. 30일이 지난 key의 재요청은 최초 응답을 재생하지 않고 새 요청으로 처리된다: 생성은 이름이 비어 있으면 새 namespace(201), 있으면 409이고, 같은 key에 다른 본문도 422가 아니다. 100만 namespace 데이터셋에서 receipt 140만 행을 지우는 데 약 30초가 걸린다. migration `AddIdempotencyKeyCreatedAtIndex1791700000014`(인덱스만 추가)가 필요하다. 삭제한 행은 백업 복원 외에 되돌릴 수 없다. 결정은 api ADR-0034다.
- 업로드 세션 정책 파일의 `namespaces` 항목은 선택 override가 됐다. `resumable-upload`가 켜진 namespace의 항목이 없으면 전역 `maxStagedBytes`·`maxActiveSessions`를 쓴다. 이전에는 시작 오류(`Missing upload session policy for enabled namespace`)였다.
- API 시작 시 `ENCRYPTED` namespace 존재 확인이 전체 `COUNT` 대신 `EXISTS`로 바뀌었다. 마스터 키가 없는 배포의 시작이 namespace 수에 비례해 읽던 비용을 없앤다. 부분 인덱스 `idx_namespace_encrypted`를 만드는 migration `AddNamespaceEncryptedIndex1791700000013`이 추가된다. down은 인덱스만 지운다.
- capability 설정의 namespace 존재 확인을 항목마다 조회하지 않고 일괄 조회한다(PostgreSQL 1회, SQLite 1000개씩). 존재하지 않는 namespace를 적으면 시작을 거부하는 동작은 그대로다. 활동 namespace 10만 개를 설정에 나열한 API 시작이 24.9s에서 1.2s가 됐다(100만 namespace 데이터셋 측정).
- GC가 metadata 없는 object를 찾을 때 storage 목록을 page(1000개)씩 읽고 그 page의 key만 DB 인덱스로 대조한다. 전체 `storage_key` 집합과 삭제 대상 목록을 메모리에 모으던 방식을 없앴다. 100만 namespace·object 약 51.5만 개 데이터셋에서 GC 프로세스가 이전에는 Node heap 상한 96MB에서 종료했고 지금은 48MB에서 통과한다. orphan blob 후보도 `(zero_since, id)` keyset으로 500개씩 읽는다. 삭제 규칙(grace period, 삭제에 성공한 object의 행만 삭제, staging 보호)은 그대로다.
- GC가 처리 후보가 없을 때까지 batch를 끝없이 반복하던 단계(만료 session·staging 정리, 파일 만료 삭제, mutation receipt·terminal session·휴지통 prune, stale finalizing lease 복구, namespace 삭제 순회)가 단계 예산 안에서 batch를 이어 돌고 예산이 소진되면 다음 실행으로 넘긴다. 이전에는 receipt·terminal session prune과 만료 session 처리가 실행당 500건에서 멈췄다.
- change feed 보존 정리의 후보 선택을 만료 이벤트 인덱스 순서 cursor로 바꿨다. 선두 이벤트가 유효한 namespace의 만료 이벤트가 많을 때 GC가 호출마다 그 이벤트를 다시 건너뛰던 비용을 없앴다(100만 namespace·막힌 이벤트 27,000개 구성에서 GC 84.4s → 4.8s). 삭제 규칙(만료된 연속 prefix만 삭제)은 그대로다. migration `AddGcCursor1791700000012`(새 테이블 `gc_cursor`)이 추가된다. down은 테이블을 지우며 저장된 재개 위치만 잃는다.

## [1.0.1] - 2026-10-01

### Fixed

- namespace 삭제 접수의 `Idempotency-Key` 길이 검사를 헤더로 전송된 byte 수 기준으로 바로잡았다. 비ASCII 키가 실제 byte 수의 약 2배로 계산돼 255 byte 이하인데도 `400`으로 거부되던 문제다.
- `X-Mutation-Scope`의 길이 검사를 헤더로 전송된 byte 수 기준으로 바로잡았다. 비ASCII scope가 실제 byte 수의 약 2배로 계산돼 128 byte 이하인데도 `400 VFS_INVALID_MUTATION_REQUEST`로 거부되던 문제다. `content/conditional`, `mutations`, snapshot, 휴지통 `restore`, `upload-sessions` 생성에 적용된다.

## [1.0.0] - 2026-10-01

첫 릴리즈다. 이 버전 이전에 배포한 버전이 없으므로 이전 버전 대비 변경 사항은 없다.
공개 API는 `/api/v2`이며 `/api/v1`은 제공하지 않는다. 계약은 `apps/api/openapi.yaml`(1.0.0)이다.

### Added

**namespace와 파일시스템 API**

- namespace 생성·목록·상세 조회. 생성은 `Idempotency-Key`로 결과를 원자적으로 저장한다.
  같은 key와 같은 본문은 최초 201로 수렴하고, 같은 key에 다른 본문은 422 `IDEMPOTENCY_KEY_REUSED`다.
- namespace `accessPolicy`(`PRIVATE`/`PUBLIC`)는 생성 시 정하며 바꿀 수 없다. `ENCRYPTED` namespace의
  콘텐츠는 AES-256-CTR로 암호화하고, `ENCRYPTED`이면서 `PUBLIC`인 생성 요청은 400으로 거부한다.
- `PUBLIC` namespace의 무인증 `GET /api/v2/public/{ns}/fs/download`·`/fs/content`. `PUBLIC`이 아닌
  namespace는 404다.
- 디렉터리·파일 CRUD와 경로 조작. `mv`·`rm`·`cp`는 Blob 단위 Copy-on-Write이며 참조가 0이 된 Blob은
  grace period 뒤 GC가 지운다.
- 모든 파일·snapshot 경로 입력에 공통 규칙을 적용한다. 절대경로와 NFC 이름을 요구하고 중복 `/`·`.`·끝 `/`는
  정규화한다. `..`·백슬래시·제어 문자·Bidi_Control·고립 surrogate·NFC가 아닌 이름은 400 `VFS_INVALID_PATH`다.
  이름은 UTF-8 255바이트, 정규 절대경로는 4096바이트까지다. 부모 자동 생성은 명시적 옵션에서만 허용한다.
- 인증·PUBLIC 콘텐츠·다운로드·snapshot 콘텐츠의 단일 byte Range 조회. 206은 `Content-Range`·`Content-Length`·
  `Accept-Ranges: bytes`와 파일 ID·revision(snapshot은 snapshot ID도)을 제공하고, 처리할 수 없는 Range의 416은
  `Content-Range: bytes */<전체 길이>`를 제공한다. 206에는 전체 파일 SHA-256을 제공하지 않는다.
- `GET /fs/presigned-download`. URL은 노드의 MIME type을 `response-content-type`으로 서명하므로
  `GET /fs/content`·공개 URL과 같은 `Content-Type`을 응답한다.
- 조건부 파일 생성·교체 결과의 `resource.id`·`resource.revision`, `GET /fs/stat`의 노드 ID·revision·FILE SHA-256,
  인증된 전체 `GET /fs/content` 200의 `X-Storix-File-Id`·`X-Storix-Revision`·`X-Storix-Sha256` 헤더.
- namespace 응답(생성·목록·상세·quota 변경)에 적용 단일 파일 상한 `limits.maxFileSizeBytes`(10진 문자열).

**조건부 변경과 재시도**

- revision(`r1.`) 기반 조건부 변경. `GET /fs/revision`, `GET /fs/ls?consistency=revision`(디렉터리 revision이
  바뀌면 cursor는 412), 조건부 디렉터리·트리 변경 `POST /fs/mutations`, raw stream 업로드
  `POST /fs/content/conditional`을 제공한다. 412 응답 body의 `current`에 충돌 시점의 노드 metadata와
  `revision`(노드가 없으면 `null`)을 싣는다.
- 조건부 mutation·content와 snapshot 생성·복원·삭제는 완료 시점부터 30일 동안 receipt를 재생한다.
  - 같은 key와 같은 fingerprint의 재시도는 최초 status·body·`X-Request-Id`를 돌려준다.
  - 결정적 4xx(400 `VFS_INVALID_PATH` 포함·404·409·412·428과 삭제·복사·snapshot 상한의 413)도 저장한다.
    404·412·413 뒤 상태를 고쳐 같은 key로 재시도하면 최초 오류가 재생되므로 새 key를 써야 한다.
  - 5xx, 일시 오류, `MUTATION_IN_PROGRESS`, `MUTATION_KEY_REUSED`, 401은 재생하지 않는다.
  - receipt가 만들어지기 전에 끝나는 오류는 재시도 응답 bytes의 동일성을 보장하지 않는다: JSON 본문 16 KiB 초과 413,
    잘못된 `Idempotency-Key`·`X-Mutation-Scope` 400, namespace 부재 404, content의 `Content-Length` 형식 오류 400,
    파일 크기 상한 413.
- 조건부 mutation에 `setMimeType`(bytes 변경 없이 mimeType만 갱신)과 move/copy의 `destinationResolution: "exact"`
  (지정 경로가 있으면 대상 metadata를 담은 412를 재생 가능 receipt로 저장)를 지원한다.
- 전체 평문 SHA-256 검증: raw 업로드의 `X-Content-Sha256`, 재개 업로드 세션 생성의 `sha256`. 잘못된 값은 400,
  불일치는 파일·revision 변경 없이 422다.
- 새 FILE의 만료를 조건부 content의 `X-Expires-In`, 재개 업로드와 조건부 copy의 `expiresInSeconds`로 지정한다
  (기본 60~2592000초, 설정으로 조정). 파일 metadata의 `expiresAt`으로 조회하고 `persist`로 확정하면 만료가
  해제된다. 만료된 미확정 파일은 GC가 namespace 휴지통 정책에 따라 삭제한다. 만료 예정 파일은 PUBLIC
  namespace의 무인증 `content`·`download`에서 404로 숨기고 확정 뒤 공개한다.

**snapshot, 휴지통, quota**

- 불변 FILE/TREE snapshot. 생성·ID 조회·cursor 목록(`GET /fs/snapshots`)·내용 조회·FILE 복원·삭제를 제공한다.
  FILE snapshot의 `sha256`은 보존 바이트의 값이고 TREE는 `null`이다. 생성 요청의 선택 필드 `sourceRevision`이
  원본의 현재 revision과 다르면 snapshot을 만들지 않고 412다(검사 순서 404 → 409 → 412).
  snapshot이 없거나 ID 형식이 틀리면 404 `VFS_SNAPSHOT_NOT_FOUND`, 복원 대상이 FILE이 아니면 409
  `VFS_INVALID_OPERATION`이다. namespace별 snapshot 보존 한도를 두고 Blob GC 참조를 관리한다.
- 휴지통은 namespace별 설정이며 기본 OFF다. OFF 삭제는 즉시 영구 삭제하고 `X-Trash-Id`·`trashId`를 반환하지
  않는다. ON 삭제는 복구 가능한 휴지통으로 옮기고 목록·원래 ID 복구·관리자 영구 삭제 API를 제공한다.
  기본 보존 30일, namespace별 기본 100000 node 상한이며 만료 항목은 GC가 배치로 purge한다. OFF로 전환하기
  전의 휴지통 항목은 계속 복원할 수 있다. 정책은 관리자 `PATCH`로 바꾼다.
- namespace별 논리 저장량 상한. live FILE과 보존 snapshot의 FILE entry bytes를 합산하고 namespace 생성 또는
  관리자 `PATCH /api/v2/admin/namespaces/{id}/quota`로 설정한다. 초과 변경은 원자적으로 413
  `VFS_QUOTA_EXCEEDED`다. 사용량보다 낮은 상한도 받아들이며 새 저장만 막는다. `maxTotalLogicalBytes` 외 필드가
  있는 요청은 400 `NAMESPACE_INVALID_TOTAL_LOGICAL_BYTES`다.
- 관리자 전용 namespace 삭제 접수 `POST /api/v2/admin/namespaces/{namespaceId}/delete`와 상태 조회
  `GET /api/v2/admin/namespaces/{namespaceId}/deletion`. 접수 뒤 데이터 접근을 차단하고 이름을 새 UUID로
  재사용할 수 있다. GC가 live·snapshot·휴지통·재개 업로드 데이터를 비동기로 정리하며 미정착 PUT는 완료를
  보류한다. 삭제 취소와 복원은 지원하지 않는다. 정리를 진행하려면 배포에 GC 예약이 있어야 한다.

**선택 capability**

- 기본 비활성 capability를 `STORIX_VFS_CAPABILITIES_CONFIG_PATH`의 시작 JSON으로 켠다. 값이 비어 있으면 모두
  비활성이고, 지정한 파일의 읽기·schema·namespace·registry 검증 실패는 시작 오류다. 비활성 capability의 요청은
  409 `VFS_FEATURE_DISABLED`다. `GET /api/v2/namespaces/{id}/capabilities`가 활성 capability ID를 사전순으로
  반환한다.
- `resumable-upload`: 세션 생성·조각 저장·상태 조회·완료·취소 API. 같은 조각의 평문 SHA-256 재전송,
  활동 기반 만료 갱신, 전역·namespace 임시 저장량 및 활성 세션 한도, 암호화 staging, GC 정리를 지원한다.
  완료는 저장된 조각을 순서대로 합쳐 조건부 파일 변경과 논리 quota를 한 DB 트랜잭션에서 공개하고, 결과와
  `X-Request-Id`를 재시도 시 재생한다. 완전 업로드된 기존 세션은 capability를 끈 뒤에도 완료할 수 있다.
  프로세스 중단으로 staging PUT 정착 여부가 불명확한 예약은 자동으로 과금 해제하지 않으므로 상한을 소진하면
  추가 업로드가 용량 한도 오류를 반환할 수 있다.
- `change-feed`: `GET /api/v2/namespaces/{namespaceId}/fs/changes`. 초기 checkpoint 뒤 변경을 namespace
  순서의 cursor 페이지로 재생한다. 기본 보존 30일 이전 cursor는 410으로 전체 재동기화를 요구한다.
  한 transaction에서 자식을 생성·삭제해도 커밋된 디렉터리 listing revision이 바뀌면 최종 revision의
  `updated` 이벤트를 기록한다.

**오류 계약과 운영**

- 식별된 DB·Blob 일시 장애는 503 `STORAGE_UNAVAILABLE`, 영구 저장 오류는 500 `STORAGE_FAILURE`, 분류되지 않은
  오류는 500 `INTERNAL_ERROR`다. 응답에는 내부 오류 메시지와 비밀을 싣지 않고, 원본 오류(SQLSTATE·SDK 코드)는
  서버 로그의 `Caused by:`에 남긴다(`STORAGE_FAILURE`는 error, `STORAGE_UNAVAILABLE`은 warn).
- 서비스 간 인증(API 키, 무중단 로테이션)과 관리자 키. 인증 키 거부도 request ID·HTTP 작업·경로·401 결과를
  비동기 best-effort로 감사 기록한다. 관리자 quota·휴지통·삭제 요청은 성공·실패를 모두 기록하고, snapshot ID를
  감사 행에 보존한다. 파일 본문과 인증 키 원문은 기록하지 않는다.
- 구조화 로깅과 `requestId`, Prometheus 메트릭, Sentry 오류 보고(`STORIX_SENTRY_DSN`), `app` 컨테이너 healthcheck.
- 저장소: PostgreSQL과 SQLite. SQLite는 단일 서버 인스턴스 전제이며 모든 쿼리를 한 줄로 직렬화한다(ADR-0025).
  앞선 트랜잭션이 30초를 넘으면 대기 요청은 503 `DB_BUSY`와 `Retry-After: 1`로 응답하고 receipt로 저장하지
  않으므로 같은 `Idempotency-Key`로 재시도할 수 있다. 이 코드는 SQLite에서만 나온다.
- 객체 저장소는 S3 호환 백엔드(VersityGW 포함)를 AWS SDK for JavaScript v3로 사용한다. `STORIX_STORAGE_REGION`을
  비우면 `us-east-1`이다. 실제 AWS S3는 버킷 리전을 지정해야 한다.
- 백업·복구: PostgreSQL 스냅샷(또는 SQLite 덤프)과 객체 미러(`blobs/`). `restore`는 `blobs/` 외의 하위 디렉터리가
  있는 백업을 기존 데이터를 지우기 전에 `RestoreUnsupportedBackupError`로 거부한다.
- 한도 환경변수는 `STORIX_*` 접두어이며 업로드 상한·요청 본문 상한·namespace별 재정의를 지원한다. 환경변수가
  비어 있으면 명시적 기본값을 쓴다.

**배포와 개발 도구**

- API 이미지는 `node:24.20.0-alpine`(musl) 기반이다. 이미지에 npm·npx·yarn·`bash`·`curl`이 없고, 컨테이너 안
  명령은 `node`·`pnpm`·busybox `sh`를 쓴다. Trivy 검사에서 최종 이미지의 HIGH·CRITICAL 취약점은 0건이다
  (`apps/api/docs/adr/0031`).
- 태그 push(`vX.Y.Z`)가 트리거하는 릴리즈 워크플로: CHANGELOG 섹션 추출과 `ghcr.io/cp949/storix` 이미지 배포
  (`docs/deployment/release.md`). 업그레이드 절차는 `docs/deployment/upgrade.md`다.
- 배포 구성: 백엔드 중립 base compose와 백엔드별 override, nginx reverse-proxy 샘플, 단일 개발 호스트와 공유
  PostgreSQL·NAS 기반 2노드 환경에서 기존 Nginx의 private listener로 WAS → Storix mTLS를 적용하는 선택형 시나리오.
- 버저닝 정책: 릴리즈 태그는 SemVer이고 breaking change는 `/api/v1` → `/api/v2` 전체 교체(병행 노출 없음)로
  표현한다(`docs/adr/0007`, `apps/api/docs/adr/0020`).
- 공개 HTTP 계약 검증 `pnpm contract`(`apps/contract`). PostgreSQL·SQLite에서 계약 57개를 실행한다.
- Turborepo + pnpm 모노레포. 패키지는 `@cp949/storix-*`이며 `apps/api`, `apps/admin`, `apps/contract`,
  `apps/demo1/{web,was}`로 구성한다. demo1은 사용자별 문서 아카이브 예시이며 재개 업로드(WAS가 세션·조각·완료·
  취소를 중계하고 웹이 중단 후 저장된 조각을 건너뛰어 이어 보냄)와 MIME type 수정을 포함한다. all-in-one 데모의
  `enable-resumable-upload.sh`·`compose.resumable.yml`과 `smoke-test.sh`를 CI가 실행한다.
- `apps/api/openapi.yaml`(1.0.0): namespace 사전 조건과 파일 생성·조회·조건부 교체·FILE snapshot 복원까지의
  curl 예시를 포함한다.
