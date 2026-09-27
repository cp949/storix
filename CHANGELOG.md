# Changelog

이 문서는 Storix(고객당 단일 인스턴스로 배포되는 `apps/api` 제품)의 주목할 만한
변경사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를
따른다. `[Unreleased]`를 버전 섹션으로 바꾸는 시점의 태그(`vX.Y.Z`)가 그 버전을
릴리즈한다(`docs/deployment/release.md`). `package.json` 버전과의 동기화 정책은
아직 없어(`API-03`) 이 문서의 버전 번호가 지금은 유일한 근거다.

## [Unreleased]

### Added

- `POST /api/v2/namespaces/{namespaceId}/fs/upload-sessions/{sessionId}/complete`로 저장된 조각을 순서대로 합쳐 조건부 파일 변경·논리 quota를 한 DB 트랜잭션에서 공개한다. 완료 결과와 `X-Request-Id`는 재시도 시 재생하며, 재회수된 완료 작업자는 lease token 검증으로 공개를 차단한다.

- 재개 업로드의 선택 capability, 유한 quota 설정, 세션·조각·사용량 저장 모델과 가역 마이그레이션을 추가했다.

- 선택 VFS capability의 시작 JSON 설정 기반과 409 `VFS_FEATURE_DISABLED` 오류를 추가했다. `STORIX_VFS_CAPABILITIES_CONFIG_PATH`가 비어 있으면 선택 기능은 모두 비활성이고, 지정한 파일의 읽기·schema·namespace·registry 검증 실패는 시작 오류다.

- `GET /api/v2/namespaces/{id}/capabilities`로 ACTIVE namespace의 실제 활성 선택 capability ID를 조회한다. 서비스 Bearer 인증을 적용하고 ID는 사전순으로 반환하며, 활성 의존 ID를 포함하고 빈 production registry에서는 빈 배열을 반환한다.

- OpenAPI에 namespace 사전 조건과 파일 생성·조회·조건부 교체·FILE snapshot 복원까지의 curl 예시를 추가했다. revision, 전체 바이트 SHA-256, 실행 중 한도 확인, receipt의 30일 재생 범위도 설명한다.

- 조건부 move/copy에 선택 필드 `destinationResolution: "exact"`를 추가했다. 지정 경로(`/` 포함)가 이미 있으면 대상 metadata를 담은 412를 재생 가능 receipt로 저장하고, 없으면 정확한 경로에 이동·복사한다. 디렉터리를 자기 자신이나 subtree로 지정한 요청은 기존과 같이 409 `VFS_INVALID_OPERATION`이다. 필드를 생략하면 기존 목적지 배치 규칙을 유지한다.

- 식별된 DB·Blob 일시 장애는 503 `STORAGE_UNAVAILABLE`, 영구 저장 오류는 안전한 500 `STORAGE_FAILURE`로 구분한다. 분류되지 않은 서버 오류는 500 `INTERNAL_ERROR`를 반환하며 내부 오류 메시지와 비밀을 노출하지 않는다. `DB_BUSY`는 기존 503 계약을 유지한다. 두 저장 장애 코드의 원본 DB·Blob 오류(SQLSTATE·SDK 코드 등)는 응답 대신 서버 로그에 `Caused by:`로 남는다(`STORAGE_FAILURE`는 error, `STORAGE_UNAVAILABLE`은 warn).

- namespace 응답(생성·목록·상세 조회·quota 변경)에 적용 단일 파일 상한 `limits.maxFileSizeBytes`(바이트 단위 10진 문자열)를 추가했다.

- `GET /api/v2/namespaces/{namespaceId}/fs/snapshots`로 immutable 파일 ID별 FILE snapshot의 생성 시각·revision·크기·SHA-256을 cursor 페이지 조회한다.

### Changed

- 인증 키 거부도 request ID, HTTP 작업, 경로, 401 결과로 비동기 best-effort 감사 기록한다. 감사 행에 snapshot ID를 보존해 snapshot 생성과 개별 ID 작업을 연결한다. 파일 본문과 인증 키 원문은 기록하지 않는다.

- snapshot 자체가 없거나 snapshot ID 형식이 잘못된 경우 404 `VFS_SNAPSHOT_NOT_FOUND`를 반환한다. 파일 경로·snapshot 내부 entry 부재는 404 `VFS_NODE_NOT_FOUND`를 유지한다. 복원 대상 snapshot 종류가 FILE이 아니면 409 `VFS_INVALID_OPERATION`을 반환한다.

- namespace 생성과 idempotency 결과를 원자적으로 저장한다. 같은 `Idempotency-Key`와 같은 본문의 동시 요청 또는 재시도는 최초 201 응답으로 수렴하고, 같은 키에 다른 본문을 보내면 422를 반환한다.

- 조건부 오류 receipt를 확정하는 중 claim을 잃었고 namespace가 이미 삭제됐다면 500 대신 404 `NAMESPACE_NOT_FOUND`를 반환한다. receipt는 저장되지 않는다.

- 조건부 mutation(`POST /fs/mutations`, `POST /fs/content/conditional`)과 snapshot 생성·복원·삭제는
  결정적 4xx 응답도 receipt로 저장해 완료 시점부터 30일 재생한다. 대상은 요청 파싱·작업 단계의
  400(`VFS_INVALID_PATH` 포함)·404·409·412·428과 결정적 413(삭제·복사·snapshot 상한)이며, 같은 key와
  같은 fingerprint의 재시도는 최초 status, body, `X-Request-Id`를 돌려준다. 파싱은 claim 전에 실행하고
  오류는 claim을 소유한 요청만 저장하므로, 같은 key의 완료 receipt(재생 또는 `MUTATION_KEY_REUSED`)와
  진행 중 claim(`MUTATION_IN_PROGRESS`)이 파싱 오류보다 우선한다. 5xx, 일시 오류,
  `MUTATION_IN_PROGRESS`, `MUTATION_KEY_REUSED`, 401은 재생하지 않고 `Retry-After`는 저장하지 않는다.
  이전에는 세 endpoint 모두 작업 단계의 404·409·412·413을 저장하지 않아 같은 key 재시도가 상태를 다시
  평가했고, 파싱 단계 오류 중 `VFS_INVALID_PATH`는 mutation·content에서만 저장하지 않았다(snapshot은 저장).
- 404·412·413 뒤 상태를 고쳐 같은 key로 재시도하면 최초 오류가 재생된다. 새 key를 사용해야 한다.
  `VFS_INVALID_PATH`도 저장되므로 경로를 고친 요청은 같은 key에서 `MUTATION_KEY_REUSED`를 받는다.
- snapshot restore/delete에서 UUID 형식이 아닌 `snapshotId`의 404도 유효한 identity와 namespace가 있으면 receipt로 저장한다.
  같은 key에서 다른 body를 보내면 409 `MUTATION_KEY_REUSED`를 받는다.
- 재생할 수 없는 오류(receipt가 만들어지기 전에 끝나는 경우)는 이전과 같이 재시도해도 최초 응답 bytes의
  동일성을 보장하지 않는다: JSON 본문 16 KiB 초과 413, 잘못된 `Idempotency-Key`/`X-Mutation-Scope` 400,
  namespace 부재 404, content의 `Content-Length` 형식 오류 400·파일 크기 상한 413.
- `POST /fs/content/conditional`의 fingerprint가 유효하지 않은 조건 헤더의 원본 값을 포함하도록 바뀌었다.
  이전 빌드는 파싱 단계 오류 전부(428, 잘못된 조건 헤더 400, `VFS_INVALID_REVISION` 400, 유효한 헤더로 보낸
  루트 경로 `/` 400)를 조건 자리에 고정 문자열 `invalid`를 넣은 fingerprint로 저장했다. 그 receipt와 같은
  요청을 재시도하면 최대 30일 동안 재생 대신 409 `MUTATION_KEY_REUSED`를 받는다. 이 endpoint는 릴리즈된
  버전에 없으므로 이 변경 이전의 미릴리즈 중간 빌드에서 저장된 receipt에만 해당한다. mutation·snapshot의
  기존 receipt와 조건이 유효한 content receipt는 영향이 없다. 예외로, 변경 전 빌드에서 `sourceRevision` 키를
  담아 허용되지 않은 키 400으로 저장된 snapshot 생성 receipt는 그 요청이 이제 유효하게 파싱되면 fingerprint가
  달라 같은 재시도가 `MUTATION_KEY_REUSED`를 받는다(해당 endpoint 미릴리즈).
- 모든 파일·snapshot 경로 입력에 공통 계약을 적용한다. 절대경로와 NFC 이름을 요구하고,
  중복 `/`·`.`·끝 `/`는 정규화한다. `..`·백슬래시·제어 문자·Bidi_Control·고립
  surrogate와 NFC가 아닌 이름은 400 `VFS_INVALID_PATH`로 거부한다. 이름은 UTF-8
  최대 255바이트, 정규 절대경로는 최대 4096바이트이며 이동·복사 결과와 하위 경로에도
  적용한다. 부모 자동 생성은 명시적 옵션에서만 허용한다.
- 공개 API를 `/api/v2`로 전체 교체했다. `/api/v1`은 병행 제공하지 않으므로 호출자와
  프록시 경로를 함께 바꿔야 한다.

### Added

- 조건부 파일 생성·교체 결과의 `resource.id`·`resource.revision`, `GET /fs/stat`의 노드 ID·revision·FILE SHA-256, 인증된 전체 `GET /fs/content` 200의 `X-Storix-File-Id`·`X-Storix-Revision`·`X-Storix-Sha256` 헤더를 공개한다. FILE snapshot 생성·ID 조회에는 보존 바이트의 `sha256`을 추가하고 `rootNodeId`를 원본 파일 ID로 명시한다. TREE의 `sha256`은 `null`이다.

- namespace별 논리 저장량 상한을 추가했다. live FILE과 보존 snapshot의 FILE entry bytes를 함께 계산하며, namespace 생성 또는 전용 관리자 API에서 상한을 설정할 수 있다. 초과 변경은 원자적으로 413 `VFS_QUOTA_EXCEEDED`를 반환하고, namespace 응답에 적용 상한과 사용량을 decimal string으로 제공한다.

- FILE snapshot 생성 요청에 선택 필드 `sourceRevision`(`r1.`)을 추가했다. 원본의 현재 revision과 다르면
  snapshot을 만들지 않고 412를 반환한다. 비교는 캡처와 같은 transaction에서 수행하며 검사 순서는
  404 → 409 → 412다. 문자열이 아닌 값(`null`·숫자·불리언·객체·배열)이나 TREE 요청에 지정하면 400
  `VFS_INVALID_MUTATION_REQUEST`, 문자열이지만 형식이 틀리면 400 `VFS_INVALID_REVISION`이다. 생략하면
  기존 동작과 같다. SQLite 단일 프로세스 배포에서는 쿼리 게이트가 트랜잭션을 직렬화해 비교와 캡처의
  원자성을 보장한다(`docs/design/02-receipt-error-replay.md`).
- 412 응답 body에 `current`(충돌 시점의 대상 노드 metadata와 `revision`, 노드가 없으면 `null`)를 추가했다.
  `current`에는 충돌 시점 노드의 공통 필드와 `revision`(`r1.`)이 있으며, stat 전용 `sha256`은 없다.
  `GET /fs/ls?consistency=revision`의 만료 cursor 412에는 디렉터리
  metadata가 실린다. receipt로 재생할 때 `current`는 `revision`을 포함해 최초 값이다.
- 불변 VFS FILE/TREE snapshot을 추가했다. 원본 변경 후 고정된 파일 내용을
  조회하고, FILE을 revision 조건으로 복원하며, 명시적으로 삭제할 수 있다.
  namespace별 snapshot 보존 한도와 Blob GC 참조를 관리한다.
- VFS `POST /fs/mutations` 조건부 디렉터리·트리 변경과 30일 재시도 영수증.
  기존 변경 경로의 요청·응답 형식은 유지하면서 조상 revision을 갱신한다.
- `POST /fs/content/conditional` raw stream 업로드에 revision 조건과 30일 영수증 재생을 추가했다.
- `GET /fs/revision`과 `GET /fs/ls?consistency=revision`을 추가했다. 새 목록 cursor는
  디렉터리 revision이 바뀌면 412를 반환한다.

- 단일 개발 호스트와 공유 PostgreSQL·NAS 기반 2노드 운영 환경에서 기존
  Nginx의 private listener로 WAS → Storix mTLS를 적용하는 선택형 배포 시나리오
- OpenAPI 스펙 초안(`apps/api/openapi.yaml`) — namespace/fs API 계약 문서(`API-01`)
- 태그 push(`vX.Y.Z`) 트리거 릴리즈 워크플로 — CHANGELOG 섹션 추출 + GHCR
  이미지 배포(`API-02`)
- 버저닝/breaking-change 정책 — 릴리즈 태그는 SemVer, breaking change는
  `/api/v1` → `/api/v2` 전체 교체(병행 노출 없음)로 표현(`API-03`,
  `docs/adr/0007`, `apps/api/docs/adr/0020`)
- namespace `accessPolicy`(`PRIVATE`/`PUBLIC`) 도입. 생성 시 결정되며 변경할 수 없다.
- `GET /api/v2/public/{ns}/fs/download`, `GET /api/v2/public/{ns}/fs/content` 무인증
  다운로드 엔드포인트 추가. `PUBLIC`이 아닌 namespace는 404로 응답한다.
- `ENCRYPTED` namespace를 `PUBLIC`으로 생성하는 요청을 400으로 거부한다.

### Fixed

- namespace·파일 API에서 발생한 500 오류가 `STORIX_SENTRY_DSN`을 설정해도 Sentry로 보고되지 않던 문제를 고쳤다. 컨트롤러 단위 예외 필터에 오류 보고기가 주입되지 않았다.
- admin quota 변경(`PATCH /api/v2/admin/namespaces/{namespaceId}/quota`) 요청이 감사 기록에 남지 않던 문제를 고쳤다. admin 키 거부뿐 아니라 성공·실패 결과도 기록한다.
- 조건부 content 요청의 파싱 오류로 receipt를 저장할 때 긴 본문 해시 중 lease가 만료되던 문제를 고쳤다. 해시와 오류 receipt 저장이 끝날 때까지 claim을 갱신한다.
- SQLite 드라이버에서 동시 요청의 트랜잭션·쿼리가 직렬화·격리되지 않던 결함을 고쳤다(#5). 같은 틱에 시작한 트랜잭션은
  `cannot start a transaction within a transaction`으로 실패했고, 뒤늦게 겹친 트랜잭션은 앞 트랜잭션의 롤백에 함께 사라졌으며
  트랜잭션 밖 쿼리는 열린 트랜잭션에 섞였다. 스냅샷 본문 조회가 스토리지를 기다리다 실패하면 그동안 `201`을 받은 다른 요청의
  쓰기가 사라질 수 있었다. 이제 모든 쿼리를 한 줄로 직렬화한다(ADR-0025). PostgreSQL은 변하지 않는다.
- SQLite에서 트랜잭션 대기가 30초를 넘으면 503 `DB_BUSY`와 `Retry-After: 1`로 응답한다. 이 코드는 SQLite에서만 나오고 receipt로
  저장하지 않으므로 같은 `Idempotency-Key`로 재시도할 수 있다.

## [0.1.0] - 2026-09-08

첫 항목이라 과거 커밋 이력 전체 대신, 이 시점까지 쌓인 기능을 baseline으로
요약한다.

### Added

- 파일시스템식 API: namespace 생성, 디렉터리/파일 CRUD, 경로 조작
- `mv`/`rm`/`cp`를 Blob-level Copy-on-Write로 지원
- 참조가 0이 된 Blob의 grace period 기반 GC
- 구조화 로깅 + `requestId`
- 서비스 간 인증(API 키 슬라이스, 무중단 로테이션)
- namespace별 리소스 상한 오버라이드, 요청 본문 크기 상한
- `ENCRYPTED` namespace 콘텐츠 암호화(AES-256-CTR)
- 감사 로그(요청 단위 접근 기록)
- CI 취약점 관리 게이트(의존성 audit + 컨테이너 이미지 스캔)
- S3/MinIO/VersityGW 커스텀 엔드포인트 지원
- Presigned download URL 발급
- nginx reverse-proxy 샘플 구성
- 메트릭(Prometheus)/에러 리포팅(Sentry)
- 백업/복구 절차(Postgres 스냅샷 + 스토리지 미러)
- `app` 컨테이너 healthcheck
- 업그레이드 절차 문서(`docs/deployment/upgrade.md`)

### Changed

- 저장소를 Turborepo + pnpm 모노레포로 전환(`apps/api`/`apps/admin`/`apps/demo`)
- 환경변수를 벤더중립 `STORAGE_*`로, 이후 전체를 `STORIX_*` 접두어로 통일
- compose 구성을 백엔드 중립 base + 백엔드별 override 구조로 재구성
- 헬스체크 응답 키를 `minio`에서 `storage`로 변경

### Fixed

- 업로드 상한 등 한도값 환경변수 미설정 시 fallback 동작을 명시적 기본값
  적용으로 통일(이전엔 파일 크기 상한이 빈 값일 때 1바이트로 좁혀지는 결함)
