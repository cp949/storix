# Changelog

이 문서는 Storix(고객당 단일 인스턴스로 배포되는 `apps/api` 제품)의 주목할 만한
변경사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를
따른다. `[Unreleased]`를 버전 섹션으로 바꾸는 시점의 태그(`vX.Y.Z`)가 그 버전을
릴리즈한다(`docs/deployment/release.md`). `package.json` 버전과의 동기화 정책은
아직 없어(`API-03`) 이 문서의 버전 번호가 지금은 유일한 근거다.

## [Unreleased]

### Added

- 배포 시나리오 `docs/deployment/scenarios/single-host-private/`를 추가했다. NAS 없이 한 호스트에서 WAS·Storix·VersityGW를 모두 Docker로 운영하는 구성이다. `storix-front` network에는 WAS와 Storix `app`만 두고 VersityGW·DB는 internal network에 분리한다. `app`의 host 포트 게시를 제거하고 `NET_RAW`를 제거한다. 코드와 공개 계약은 바뀌지 않는다.
- 비밀값을 파일(`<변수>_FILE`)과 통신형 어댑터(`<변수>_REF`, `STORIX_SECRET_ADAPTERS`)로 받는다. 대상은 API key, 마스터 키, DB·스토리지 자격증명, Sentry DSN이다. 값은 기동 시 한 번 읽는다. 결정은 api ADR-0040이고 규칙은 `docs/design/15-secret-sources.md`다.
- `single-host-private` 시나리오에 compose secret override(`compose.secrets.yml`, `compose.secrets-postgres.yml`)를 추가했다. VersityGW는 이 override의 파일 전달 대상이 아니다. `STORIX_STORAGE_*`는 환경변수로 남는다.
- 400 오류 코드 `VFS_INVALID_QUERY`를 추가했다. `GET /fs/find`의 `name`이 유효하지 않을 때 쓴다.
- 스토리지 호출의 timeout 환경변수 `STORIX_STORAGE_SOCKET_TIMEOUT_MS`(기본 120000)·`STORIX_STORAGE_CONNECT_TIMEOUT_MS`(기본 10000)를 추가했다. 양의 정수만 받고 `0`은 거부한다. 결정은 api ADR-0012다(GitHub 이슈 #44).
- GC가 강제 종료로 남은 미완료 multipart upload를 abort한다. 시작 뒤 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`와 `STORIX_ORPHAN_GRACE_PERIOD`(기본 합 2일)가 지난 `blobs/`·`upload-staging/` upload만 대상이다. 이전에는 조각이 스토리지에 남았고 완성 object가 아니라서 orphan object 단계가 보지 못했다. 스토리지 계정에 `s3:ListBucketMultipartUploads`·`s3:AbortMultipartUpload` 권한이 필요하다. gc 서비스에 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`를 전달한다. 결정은 api ADR-0045다.
- 스토리지 동시 연결 상한 환경변수 `STORIX_STORAGE_MAX_SOCKETS`(기본 50, 1~65535)를 추가했다. 기본값은 이전 동작과 같다. 결정은 api ADR-0012다.

### Changed

- S3 호환 스토리지가 응답을 멈춰도 소켓과 요청 처리가 무기한 남던 문제를 고쳤다. 소켓 무활동 120초(`STORIX_STORAGE_SOCKET_TIMEOUT_MS`)가 지나면 요청을 끊는다. 응답 헤더 전에 멈춘 경우는 이전에 500 `INTERNAL_ERROR`였고 이제 503 `STORAGE_UNAVAILABLE`이다. 클라이언트가 다운로드 읽기를 이 시간 넘게 완전히 멈춰도 연결이 중단된다. 큰 object의 완료 처리처럼 백엔드가 응답 전에 오래 걸리면 값을 늘린다(GitHub 이슈 #44).
- PostgreSQL `vfs_node.version`을 `integer`에서 `bigint`로 넓히고 revision 상한(`MAX_VFS_VERSION`)을 2147483647에서 2^53−1로 올렸다(마이그레이션 `WidenVfsNodeVersion1791700000023`, SQLite는 건너뜀). 모든 mutation이 조상을 root까지 올리므로 root version이 2147483647에 닿으면 그 namespace의 모든 쓰기가 409 `VFS_REVISION_EXHAUSTED`로 영구 실패했다(초당 100회 mutation이면 약 248일). 이미 발급된 revision 토큰은 그대로 유효하다. 이 마이그레이션은 `vfs_node` 테이블을 재작성하고 `ACCESS EXCLUSIVE` 락을 잡으므로 행이 많은 배포는 점검 창에서 적용한다. 2147483647을 넘는 version이 생긴 뒤에는 `down`이 `22003`으로 실패한다. 결정은 api ADR-0044다(GitHub 이슈 #41).
- `POST /fs/rm`이 `recursive` 없이 빈 디렉터리를 삭제한다. 이전에는 비어 있어도 409 `VFS_IS_DIRECTORY`였다. 비어 있지 않은 디렉터리는 409 `VFS_DIRECTORY_NOT_EMPTY`다. OpenAPI 설명과 `POST /fs/mutations`의 `kind: delete` 동작에 맞췄다.
- 메트릭 `storix_http_transferred_bytes_total`과 구조화 로그 `byteCount`가 요청 수신과 응답 송신 바이트의 합(HTTP 헤더 포함, 소켓 기준)을 센다. 이전에는 요청 `Content-Length`가 있으면 그 값, 없으면 응답 `Content-Length`만 셌다. 그래서 chunked 업로드는 응답 크기만, HEAD와 중간에 끊긴 다운로드는 보내지 않은 본문 길이까지 셌다.
- 기본 compose가 `STORIX_API_KEY` 미설정을 `docker compose` 단계에서 거부하지 않는다. `app` 기동 시점에 거부한다. 메시지는 기존 `auth.module`의 것이다.
- 정수 환경변수(포트, 초, 개수, GC 주기 등 `parsePositiveInt`로 읽는 변수)를 앞자리 0이 없는 10진 숫자만 받는다. 이전에 통과하던 `1e3`, `0x10`, `+5`, `5.0`, 공백이 붙은 값, 2^53 이상의 값은 부팅을 거부한다. `STORIX_SECRET_RESOLVE_TIMEOUT_MS`는 2147483647 ms, `STORIX_DB_PORT`·`STORIX_STORAGE_PORT`·`STORIX_STORAGE_PUBLIC_PORT`는 65535를 넘으면 부팅을 거부한다. 3000000000 ms를 설정하면 `setTimeout` 상한 때문에 1ms 뒤에 타임아웃이 나던 문제가 이 거부로 바뀐다.
- 관리자 키(`STORIX_ADMIN_API_KEY`·`STORIX_ADMIN_API_KEY_PREVIOUS`)가 서비스 키(`STORIX_API_KEY`·`STORIX_API_KEY_PREVIOUS`) 중 하나와 같은 값이면 부팅을 거부한다. 이전에는 같은 값을 넣어도 부팅되어 서비스 키로 `/api/v2/admin/*`(quota·settings·trash-policy·휴지통 purge·namespace 삭제)를 호출할 수 있었다. 오류 메시지에는 충돌한 변수 이름만 나오고 값은 나오지 않는다. 비교는 인증과 같게 공백을 제거하지 않은 값으로 한다. `STORIX_ADMIN_API_KEY`가 비어 있으면 관리자 API가 닫히므로 검사하지 않는다. 두 키를 같은 값으로 쓰던 배포는 관리자 키를 새로 생성해야 한다.
- `STORIX_DB_DRIVER`가 `postgres`·`sqlite`가 아니면 부팅을 거부한다. 이전에는 `SQLite`·`sqlite3` 같은 값이 조용히 `postgres`로 처리됐다. 빈 값과 미설정은 `postgres`다.
- `STORIX_STORAGE_USE_SSL`, `STORIX_STORAGE_PATH_STYLE`, `STORIX_STORAGE_PUBLIC_USE_SSL`, `STORIX_RESTORE_FORCE`가 `true`·`false`(대소문자 무관)가 아니면 부팅을 거부한다. 복구 잡은 시작하지 않는다. 오류 메시지에 변수 이름이 나온다. 이전에는 `1`, `yes`, `on`, 공백이 붙은 값, 오타가 조용히 false로 처리됐다. `STORIX_STORAGE_USE_SSL=1`은 평문 HTTP로 연결했고 `STORIX_STORAGE_PATH_STYLE=yes`는 path-style이 아니라 virtual-host 주소를 썼다. 이 값을 쓰던 배포는 `true`·`false`로 바꿔야 한다. 빈 값과 미설정은 기본값이다.
- 디렉터리 이동(`POST /fs/mv`, `POST /fs/mutations`의 `kind: move`)에 하위 트리 노드 수 상한을 추가했다. 이동 대상 자신을 포함한 subtree 노드 수가 `STORIX_MAX_SYNC_MOVE_NODES`(기본 10000)를 넘으면 변경 없이 413 `VFS_MOVE_LIMIT_EXCEEDED`로 거부한다. 이전에는 상한이 없어, SQLite 실측에서 하위 노드 20,000개를 옮기는 데 2.2~4.7초(깊이 10 트리)가 걸리고 그동안 같은 namespace의 mutation이 멈췄다. 이전에 성공하던 10,000개 초과 subtree 이동이 413으로 바뀐다. namespace별 override 컬럼 `namespace.max_sync_move_nodes`를 추가했고(마이그레이션 `AddNamespaceMoveLimit1791700000022`), 전역값을 넘을 수 없다. FILE 이동은 상한과 무관하다. 결정은 api ADR-0042다(GitHub 이슈 #26).
- API 서버가 `SIGTERM`·`SIGINT`를 받으면 새 연결을 막고 진행 중 요청이 끝나길 기다린 뒤 종료한다. 이전에는 신호 핸들러가 없어, 컨테이너에서 PID 1인 node가 SIGTERM을 무시하고 `docker stop`이 10초 뒤 SIGKILL로 끝났다(핸들러 없는 node PID 1 실측 10.2초, exit 137). 이제 유휴 상태에서는 즉시 종료 코드 0으로 끝난다. 대기 상한은 새 환경변수 `STORIX_SHUTDOWN_TIMEOUT_SECONDS`(기본 25초, 1~3600)다. 상한을 넘기거나 종료 중 신호가 다시 오면 남은 연결을 끊고 종료 코드 1로 끝난다. compose `app`에 `stop_grace_period: 30s`를 추가했다. `STORIX_SHUTDOWN_TIMEOUT_SECONDS`를 올리면 `stop_grace_period`도 함께 올린다. gc·backup·restore 잡은 이 변경의 대상이 아니다. 결정은 api ADR-0043이다(GitHub 이슈 #27).
- 없는 라우트의 404 응답 `code`가 `BAD_REQUEST`에서 `NOT_FOUND`로 바뀌고, `GET /health/ready` 실패 503의 `code`가 `SERVICE_UNAVAILABLE`로 바뀐다. Nest `HttpException`은 이제 `HttpStatus` 이름을 `code`로 쓴다. HTTP 상태 코드와 `message`는 같다. `/health/ready` 503 body는 표준 오류 형태이고 실패한 indicator 상세는 담지 않는다. 원인은 서버 로그(`HealthCheckService`)에서 확인한다. body-parser가 던지는 400·413은 openapi에 적힌 대로 `BAD_REQUEST`를 유지한다.
- 파일 만료 입력(`POST /fs/content/conditional`의 `X-Expires-In`, `POST /fs/mutations` copy의 `expiresInSeconds`)의 설정 범위(`STORIX_VFS_EXPIRY_MIN_SECONDS`·`STORIX_VFS_EXPIRY_MAX_SECONDS`) 검사를 멱등성 receipt 처리 뒤로 옮겼다. 이전에는 범위를 바꾸고 재시작한 뒤 같은 키로 재시도하면, 범위 안 값으로 이미 완료된 요청이 저장된 응답 대신 400 `VFS_INVALID_EXPIRY`(conditional) 또는 409 `MUTATION_KEY_REUSED`(mutations)가 됐다. 이제 저장된 응답을 재생한다. 범위 밖 `X-Expires-In`은 본문을 읽은 뒤 400을 오류 receipt로 저장한다(이전에는 본문을 읽기 전에 거부). 형식 오류(10진 정수 아님)와 조건 조합 오류는 이전처럼 본문을 읽기 전에 거부한다. 업그레이드 전에 범위 밖 `expiresInSeconds`로 거부되어 저장된 mutations 400 receipt는 같은 키로 재시도하면 409 `MUTATION_KEY_REUSED`가 된다. 범위 안 값의 receipt는 영향이 없다.
- `GET /fs/ls`의 `consistency`가 `revision`이 아니면(알 수 없는 값, 빈 문자열, 중복 파라미터) 400 `VFS_INVALID_QUERY`를 반환한다. 이전에는 `cursor`를 보내지 않아도 400 `VFS_INVALID_CURSOR`였다. HTTP 상태 코드는 같다. 없는 namespace나 잘못된 경로와 함께 보내면 이제 `consistency` 검사가 먼저 적용된다.

### Fixed

- `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`·`STORIX_VFS_CHANGE_RETENTION_DAYS`는 365000(일) 초과, `STORIX_ORPHAN_GRACE_PERIOD`는 31536000000(초) 초과 값을 시작 시점에 거부한다. 이전에는 시작이 통과하고 PostgreSQL에서 약 2.4M일부터 `timestamp out of range`, 2^31 이상에서 `integer out of range`가 나서 gc 실행이 그 단계에서 끝났다. 뒤 단계(receipt·업로드 세션·change feed·휴지통 정리)가 매 주기 실행되지 않았다. 유예 시간은 9007199254740991초에서 `Invalid Date`가 됐다. 이 범위를 넘는 값을 쓰던 배포는 값을 줄여야 한다(SQLite는 오류 없이 영구 보존처럼 동작했다).
- `openapi.yaml`의 `PATCH /api/v2/admin/namespaces/{namespaceId}/quota`(`updateNamespaceQuota`)에 `security: AdminApiKeyAuth`를 추가했다. 이전에는 선언이 없어 전역 기본값 `ApiKeyAuth`(서비스 키)로 읽혔고, 생성된 클라이언트가 관리자 키 요구를 알 수 없었다. 서버는 처음부터 `STORIX_ADMIN_API_KEY`만 받았으므로 동작은 바뀌지 않는다.
- `POST /fs/trash/{trashId}/restore`·`purge`가 JSON이 아닌 Content-Type의 본문을 조용히 무시하던 문제를 고쳤다. 이전에는 `text/plain` 등으로 `targetPath`를 보내도 무시되어 항목이 원래 경로로 복구됐다. 이제 본문이 있고 Content-Type이 `application/json`이 아니면 400 `VFS_INVALID_MUTATION_REQUEST`다. receipt를 남기지 않으므로 같은 `Idempotency-Key`로 JSON 본문을 다시 보내면 처리된다. 본문이 없는 요청과 JSON 본문 요청은 달라지지 않는다. 비JSON Content-Type으로 본문을 보내던 클라이언트는 `application/json`으로 바꿔야 한다.
- 업로드 세션 ID를 대문자 UUID로 보내면 SQLite에서만 404 `VFS_UPLOAD_SESSION_NOT_FOUND`가 나던 문제를 고쳤다(`GET`·`DELETE /fs/upload-sessions/{id}`, `PUT …/parts/{index}`, `POST …/complete`). PostgreSQL은 `uuid` 비교라 대소문자와 무관하게 통과했다. 이제 두 드라이버 모두 대문자 ID를 같은 세션으로 처리한다. 응답의 `sessionId`는 소문자 그대로다.
- change feed가 켜진 namespace에서 `POST /fs/mkdir`, `POST /fs/mutations`의 `kind: mkdir`(`parents` 포함)이 이미 있던 조상 디렉터리(root 포함)를 `updated`가 아닌 `created`로 기록하던 문제를 고쳤다. 이제 기존 조상은 `updated`, 새로 만든 디렉터리만 `created`다. 다른 mutation은 영향이 없었다. 이미 기록된 이벤트는 바뀌지 않는다.
- 디렉터리 이동(`POST /fs/mv`, `POST /fs/mutations`의 `kind: move`)이 하위 트리를 찾을 때 `namespace_id` 조건 없이 `vfs_node` 전체를 훑어, 다른 namespace의 행 수에 비례해 느리던 문제를 고쳤다. 같은 namespace 안의 노드만 조회한다. 결과 노드 집합과 상한 판정은 같다.
- 업로드 본문 수신이 5분을 넘으면 Node 기본 `requestTimeout`(300초)으로 408이 되어 연결이 끊기던 문제를 고쳤다. HTTP 서버의 `requestTimeout`을 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`(기본 24시간)에 맞춘다. 이 값은 업로드가 아닌 라우트의 본문 수신에도 적용된다. `headersTimeout`(60초)은 그대로다.
- `STORIX_MUTATION_MAX_UPLOAD_SECONDS`가 2147483를 넘거나 `STORIX_MUTATION_LEASE_SECONDS`가 6442450을 넘으면 `setTimeout` 한도를 넘어 타이머가 1ms 뒤에 발화하던 문제를 고쳤다. 부팅이 성공한 뒤 모든 업로드가 즉시 끊기거나 lease 갱신이 연속 실행됐다. 이제 두 값을 부팅 시점에 거부한다. `STORIX_MUTATION_LEASE_SECONDS`는 이전에는 요청 시점에만 검증해, 잘못된 값(`30s` 등)으로도 부팅이 성공하고 이후 모든 mutation이 500이었다. 이제 부팅 시점에 거부한다.
- SQLite에서 다른 트랜잭션이 게이트를 오래 쥐고 있을 때 대기 상한(30초)을 넘긴 트랜잭션 시작이, 현재 게이트를 쥔 트랜잭션에 `ROLLBACK`을 보내 그 쓰기를 모두 지우던 문제를 고쳤다. 게이트를 쥐지 않은 트랜잭션은 연결 상태를 건드리지 않는다. 쥐고 있던 쪽은 이전에 `SqliteTransactionAbortedError`(500)로 끝났다.
- 다운로드 도중 S3 응답이 멈춘 상태에서 클라이언트가 연결을 끊으면, S3 연결과 요청 처리가 S3의 다음 chunk가 올 때까지 남던 문제를 고쳤다. 로컬 지연 서버 재현(첫 chunk 뒤 3000ms 정지, 클라이언트 200ms 중단)에서 처리 종료·소켓 close가 3016ms에서 219ms로 줄었다. S3Client에 `requestTimeout`·`socketTimeout`이 없어 완전히 멈춘 S3 응답은 여전히 끊기지 않는다.
- capability 시작 설정(`STORIX_VFS_CAPABILITIES_CONFIG_PATH`)과 upload session 정책(`STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`)의 중복 JSON key가 조용히 마지막 값으로 적용되던 문제를 고쳤다. 같은 namespace ID를 두 번 적으면 한쪽 설정이 경고 없이 사라졌고, 코드의 중복 검사는 `JSON.parse`가 먼저 덮어써 도달할 수 없었다. 이제 같은 객체 안의 중복 key는 시작 오류다(`Duplicate key "<key>" at <경로>`). 중복 key가 있는 기존 설정 파일은 업그레이드 뒤 시작이 거부되므로 한 항목으로 합쳐야 한다.
- `GET /fs/ls?consistency=revision`에서 같은 경로의 디렉터리가 삭제 뒤 다시 만들어지면 옛 cursor가 400 `VFS_INVALID_CURSOR`이던 문제를 고쳤다. 디렉터리 revision이 바뀐 경우와 같은 412 `VFS_PRECONDITION_FAILED`로 응답한다. 클라이언트는 첫 페이지부터 다시 열거하면 된다. 다른 디렉터리의 `rc1.` cursor도 같은 이유로 400이 아니라 412다. 형식·변조 오류의 400은 그대로다.
- `Range` 헤더의 단위 이름이 대소문자를 구분해 `Bytes=1-2`가 416 `VFS_RANGE_NOT_SATISFIABLE`이던 문제를 고쳤다. RFC 9110 §14.1에 따라 `bytes` 단위를 대소문자 구분 없이 받는다. 알 수 없는 단위(`items=0-1`)는 이전처럼 416이다.
- `Range` 헤더의 숫자가 309자리 이상이면 416 `VFS_RANGE_NOT_SATISFIABLE`이던 문제를 고쳤다. 308자리 이하는 end가 파일 끝으로 잘리고 suffix(`bytes=-N`)는 전체를 돌려주는데, 309자리 이상만 `Number`가 `Infinity`로 바꿔 거부했다. 이제 같은 규칙을 따른다. start가 파일 끝 밖이면 416이다.
- 프로세스 종료로 버려진 `RESERVED` mutation receipt가 GC로 지워지지 않던 문제를 고쳤다. 같은 `Idempotency-Key` 재요청이 없으면 행이 영구히 남았다. 이제 claim 시점부터 30일이 지났고 lease도 만료된 `RESERVED` 행을 `pruneExpired`가 지운다. lease가 살아 있는 행은 남긴다.
- SQLite 복구가 대상 DB 파일이 손상됐거나 migrate 전이면 `STORIX_RESTORE_FORCE=true`여도 `SQLITE_CORRUPT`·`SQLITE_NOTADB`·`no such table: namespace`로 실패해 재실행할 수 없던 문제를 수정했다. force 복구는 대상 DB 상태를 확인하지 않는다. force 없이도 테이블이 없는 대상은 비어 있는 대상으로 복구한다. 손상된 대상에 force 없이 복구하면 이전처럼 `SQLITE_CORRUPT`로 실패한다. 복구는 임시 파일(`<STORIX_DB_SQLITE_PATH>.restore-tmp`)에 복사한 뒤 `rename`으로 교체하므로 복사가 끊겨도 기존 DB가 잘린 채 남지 않는다. 이 때문에 파일 단위 bind mount로 지정한 `STORIX_DB_SQLITE_PATH`는 복구가 `EBUSY`로 실패한다.
- 손상되거나 잘린 압축 요청 본문(`Content-Encoding: gzip`·`deflate`·`br`)이 400 `BAD_REQUEST` 대신 `Z_DATA_ERROR`·`Z_BUF_ERROR`·`ERR__ERROR_FORMAT_PADDING_N` 같은 압축 라이브러리 코드로 응답되던 문제를 수정했다. JSON·urlencoded·mutation raw 파서 단계의 오류는 이제 `code`가 `BAD_REQUEST`다. status(400)와 `message`는 그대로다. 지원하지 않는 `Content-Encoding`은 이전처럼 415 `BAD_REQUEST`다.
- 휴지통을 quota에서 제외한 namespace에서 `maxRetainedTrashBytes`를 현재 보존량 아래로 낮춘 뒤, 휴지통 byte 증가분이 0인 삭제(0 byte 파일 `rm`, 빈 디렉터리 `rmdir`)도 413 `VFS_TRASH_LIMIT_EXCEEDED`로 거부되던 문제를 수정했다. 증가분이 0이면 초과 상태에서도 허용한다. 만료된 0 byte 파일이 live로 남던 문제도 같은 원인이었다. 증가분이 양수인 삭제는 계속 거부한다.
- change feed checkpoint가 있는 namespace에서 깊은 경로의 mutation(put·touch·mv 등)이 깊이에 이차로 느려지던 문제를 수정했다. 조상마다 변경 전 상태를 읽으며 경로를 root까지 다시 계산해, SQLite 실측에서 깊이 800 기존 체인의 put이 323,641쿼리·10.3초였다(checkpoint 없으면 2,426쿼리). 이제 4,041쿼리·0.2초다. 이벤트 내용과 순서는 같다. PostgreSQL은 쿼리 수 단언을 포함한 통합 테스트는 통과했고 시간은 측정하지 않았다(GitHub 이슈 #43).
- 깊은 경로의 `mkdir -p`(`POST /fs/mkdir`의 `parents`)와 `parents=true`로 중간 디렉터리를 만드는 put·cp·mv가 깊이에 이차로 느려지던 문제를 수정했다. 새 디렉터리마다 조상 체인을 root까지 다시 조회해, SQLite 실측에서 깊이 1,000이 504,514쿼리·14.6초, 깊이 2,000이 2,009,018쿼리·57.3초였고 그동안 같은 프로세스의 다른 요청이 멈췄다. 이제 깊이 2,000이 10,018쿼리·0.46초다. 응답과 revision 증가는 같다. PostgreSQL은 측정하지 않았다(GitHub 이슈 #42).
- namespace 생성(`POST /api/v2/namespaces`) 감사 로그의 `namespace_id`가 항상 null이던 문제를 수정했다. 이제 응답의 namespace ID를 기록한다. 같은 Idempotency-Key로 재생된 성공 응답도 같다.
- 만료 시각이 지났지만 GC가 아직 EXPIRED로 전환하지 않은 업로드 세션의 취소(`DELETE /fs/upload-sessions/{sessionId}`)가 200 CANCELLED로 성공하던 문제를 수정했다. 조각 저장·완료와 같이 닫힌 세션으로 보고 EXPIRED로 전환한 뒤 409 `VFS_UPLOAD_SESSION_CLOSED`로 응답한다.
- 업로드 세션 생성(`POST /fs/upload-sessions`)이 같은 경로의 조건부 업로드·세션 완료와 다른 오류를 응답하던 문제를 수정했다. 경로 중간이 파일이면 404 대신 409 `VFS_NOT_DIRECTORY`, 처음 없는 조상 경로를 404의 `path`로, 디렉터리 대상의 revision 불일치는 409 `VFS_IS_DIRECTORY` 대신 412를 응답한다. OpenAPI 409 설명에 `VFS_NOT_DIRECTORY`·`VFS_IS_DIRECTORY`를 추가했다.
- 휴지통 보존 정리(GC)에서 manifest·counter 불일치나 root 손상 같은 예상 밖 오류가 난 항목 하나가 GC 전체를 실패시켜 모든 namespace의 만료 휴지통 정리를 막던 문제를 수정했다. 이제 그 항목만 남기고 `error` 로그를 남긴 뒤 다음 항목을 정리한다. GC 결과에 `failedTrashItems`를 추가했다.
- change feed 보존 정리(GC)에서 경계 불변식 위반 같은 예상 밖 오류가 난 namespace 하나가 GC 전체를 실패시켜, 그 뒤 namespace의 change feed 정리와 휴지통 보존 정리를 매 실행 막던 문제를 수정했다. 이제 그 namespace만 롤백하고 `error` 로그를 남긴 뒤 다음 namespace를 정리한다. GC 결과에 `failedChangeFeedNamespaces`를 추가했다.
- GC 실행 중 advisory lock 커넥션이 끊기면(PostgreSQL `idle_session_timeout`·failover) 완료한 GC가 실패(exit 1)로 보고되고 `last_completed_at`이 남지 않아 쿨다운이 적용되지 않던 문제를 수정했다. 이제 완료 시각은 별도 커넥션으로 기록하고, 끊긴 커넥션의 unlock 실패는 경고로만 남긴다. 실행 중 커넥션이 끊긴 사실도 경고로 남긴다.
- 디렉터리를 자기 하위로 이동·복사할 때 목적지 중간 경로가 없거나 파일이면 409 `VFS_INVALID_OPERATION` 대신 404 `VFS_NODE_NOT_FOUND`·409 `VFS_NOT_DIRECTORY`가 응답되던 문제를 수정했다. 경로 계약대로 자기 subtree 지정을 먼저 거부한다. `destinationParents: true`여도 중간 디렉터리를 만들지 않는다.
- 클라이언트가 응답 전에 연결을 끊은 요청이 감사 로그·메트릭(`storix_http_requests_total`의 `status`)·구조화 로그에 status 200으로 기록되던 문제를 수정했다. 이제 응답을 끝까지 보내지 못한 요청은 499로 기록한다. 다운로드 도중 끊긴 요청도 499다.
- `POST /fs/mutations`, `POST /fs/snapshots`(생성·restore·delete), `POST /fs/trash/{trashId}/restore`·`purge`의 감사 로그에 `path`·`detail`이 null로 남던 문제를 수정했다. 이 라우트는 body를 원문 그대로 받아 감사 인터셉터가 필드를 읽지 못했다. 이제 JSON으로 읽어 기록한다. `detail`에는 `kind`(mutations·snapshot 변경 종류)와 `targetPath`(휴지통 복원 위치)도 기록한다(GitHub 이슈 #39).
- 이전 버전에서 만든 PostgreSQL 백업을 복구한 뒤 `migrate` 재실행이 `relation … already exists`로 실패하던 문제를 수정했다. `pg_restore --clean`은 dump에 있는 테이블만 지워 백업 이후 버전의 테이블이 남았다. 이제 복구 전에 `public` 스키마에서 접속 사용자가 소유한 테이블을 모두 지운다. Storix 전용 DB를 전제로 한다. 운영 이미지는 이 단계에 `psql`을 쓴다(GitHub 이슈 #38).
- 백업을 만든 DB 사용자와 다른 사용자로 PostgreSQL 복구를 실행하면 `pg_restore`가 소유자 변경에서 실패하고, 일부만 적재된 채 재실행도 막히던 문제를 수정했다. 이제 소유자·권한 없이 한 트랜잭션으로 적재한다. 적재가 실패하면 테이블이 없는 상태로 남고 같은 명령으로 재실행할 수 있다(GitHub 이슈 #38).
- `GET /fs/ls`·`/fs/stat`·`/fs/exists`·`/fs/find`에서 `path`를 생략하면 namespace root 대신 400 `VFS_INVALID_PATH`가 응답되던 문제를 수정했다. OpenAPI 문서대로 생략 시 root를 대상으로 한다. 빈 값(`?path=`)은 계속 400이다(GitHub 이슈 #37).
- 업로드 세션 완료(`POST .../fs/upload-sessions/{sessionId}/complete`)가 DB 오류로 실패하면 commit 결과가 불명확해도 최종 object를 삭제하던 문제를 수정했다. PostgreSQL commit 응답이 유실되면 반영된 파일이 지워진 object를 가리켜 데이터를 잃을 수 있었다. 이제 롤백이 확정된 4xx 도메인 오류에서만 참조 없는 object를 삭제하고, 나머지는 보존해 orphan GC에 맡긴다. 일반 업로드·조건부 업로드와 같은 규칙이다(GitHub 이슈 #36).
- 디렉터리 이동·복사(`POST /fs/mv`, `POST /fs/cp`, `POST /fs/mutations`의 `move`·`copy`)가 하위 노드 수와 깊이에 비례해 DB 쿼리를 보내 느리던 문제를 수정했다. 커밋 직전 revision 갱신과 경로 계산이 노드마다 노드·부모 체인을 개별 조회했다. 이제 `IN` 청크로 읽고 부모 해석을 메모이즈한다. 응답의 `affectedRevisions` 내용은 같다. 실측(SQLite)에서 평평한 12,000개 cp의 쿼리가 36,068개에서 114개로, 깊이 1,500 체인 mv의 쿼리가 약 113만 개에서 25개로 줄었다. SQLite의 깊이 1,500 체인 mv·cp는 약 34초에서 각각 0.21초·0.25초로, 평평한 12,000개 cp는 1.4초에서 0.48초로 줄었다. PostgreSQL 평평한 12,000개 cp는 통계가 없는 새 DB에서 18~38초이던 것이 약 6.6초가 됐다. 남은 시간은 `vfs_node` 쿼리 계획 선택과 관련이 있는 것으로 추정하며 GitHub 이슈 #35가 추적한다(GitHub 이슈 #33·#34, TRP-008).
- demo1 web이 `nextCursor`를 무시해 폴더·검색 결과·폴더 트리의 101번째 이후 항목이 보이지 않던 문제를 수정했다. 이제 "더 보기" 버튼으로 다음 페이지를 불러온다. 폴더 트리 조회가 실패하면 처리되지 않은 rejection 대신 오류 패널에 표시한다.
- demo1 web에서 업로드·이동·삭제나 검색 응답이 늦게 도착해 이미 이동한 폴더의 목록·검색 결과를 덮어쓰던 문제를 수정했다. 변경 뒤 재로드는 현재 폴더를 첫 페이지부터 다시 불러온다.
- demo1 WAS가 Storix에서 401을 받으면(WAS의 Storix API 키 거부) 같은 401을 브라우저에 그대로 전달해 사용자 인증 실패처럼 보이던 문제를 수정했다. 이제 502 `STORIX_UPSTREAM_UNAUTHORIZED`와 고정 문구로 응답하고 upstream 원인은 WAS 로그에만 남긴다. 401 외 Storix 오류는 `status`·`code`·`message`를 그대로 전달한다.
- demo1 WAS가 요청 본문의 `source`·`destination`·`path`가 문자열이 아니면 500이던 문제를 수정했다. 이제 400 `DEMO_INVALID_REQUEST_BODY`로 응답한다. 필드가 없거나 `null`인 요청도 400이다. 이전에는 빈 문자열로 해석돼 사용자 root가 대상이 됐다(본문 없는 `POST /demo-api/documents/download`는 root 경로로 요청하던 것이 400으로 바뀐다). 빈 문자열은 계속 root로 해석한다.
- demo1 WAS가 잘못된 JSON 응답에 `requestId`를 싣지 않던 문제와, 100 KB를 넘는 JSON 본문에 413 대신 500 `INTERNAL_ERROR`를 반환하던 문제를 수정했다. 둘 다 `HTTP_ERROR` code와 해당 status로 응답하고 `requestId`를 싣는다.
- DB 저장 장애 일부가 분류되지 않고 500 `INTERNAL_ERROR`로 응답되던 문제를 수정했다. `SQLITE_IOERR`(확장 코드 포함)는 500 `STORAGE_FAILURE`로, `SQLITE_NOMEM`·PostgreSQL `57014`(query canceled)·code 없이 끊긴 pg 연결 오류(`Connection terminated unexpectedly`, `Client has encountered a connection error and is not queryable`)는 503 `STORAGE_UNAVAILABLE`로 응답한다. 분류하는 DB 접근 경로에 `POST /api/v2/namespaces`, `GET /api/v2/namespaces`, `GET /api/v2/namespaces/{namespaceId}/changes`가 새로 포함된다. 이전에는 이 경로에서 `SQLITE_FULL`·연결 거부 같은 이미 분류된 오류도 500 `INTERNAL_ERROR`였다. 세 엔드포인트의 OpenAPI에 503 응답을 추가했다. `Retry-After`는 붙이지 않는다.
- 백업·복구가 같은 버킷의 Storix 외 object에서 실패하거나 그 object를 삭제하던 문제를 수정했다. 백업은 버킷 전체를 순회해 `logs/` 같은 디렉터리 marker 하나로 매번 실패하고 `.partial`만 남겼다. `STORIX_RESTORE_FORCE=true` 복구는 백업에 없는 object를 버킷 전체에서 삭제했다. 이제 백업·복구·force 삭제는 Storix가 만드는 key의 prefix(`blobs/`, `upload-staging/`)만 대상으로 한다. 백업 디렉터리 구조는 같다. 이전 버전이 만든 백업에 prefix 밖 key가 있으면 복구는 되살리지 않고 경고한다. prefix 안에서 경로 정규화로 달라지는 key(`a//b`)는 다른 key로 조용히 저장하지 않고 백업을 실패시킨다.
- 복구 잡이 이름이 `.partial`로 끝나는 백업 디렉터리를 복구하던 문제를 수정했다. 백업 잡은 모든 단계가 성공한 뒤에만 `.partial`을 뗀다. 이전에는 blob 미러 도중 실패한 `<타임스탬프>.partial/`로 복구해도 DB는 복구되고 blob은 누락된 채 "복구 완료"로 끝났다. `STORIX_RESTORE_FORCE=true`면 백업에 없는 기존 object까지 삭제했다. 이제 `RestoreIncompleteBackupError`(`RESTORE_INCOMPLETE_BACKUP`)로 DB 복구와 스토리지 접근 전에 거부한다. `.partial`을 수동으로 rename한 백업은 판별하지 못한다.
- namespace 삭제 정리에서 `STORIX_GC_MAX_ROWS_PER_STAGE`(기본 200,000) 소진으로 orphan-blobs 단계가 멈춘 실행이 grace가 지난 남은 Blob을 `STORAGE_DELETE_FAILED`로 표시하던 문제를 수정했다. 스토리지 장애 없이 Blob이 많은 namespace(예: 30만 개)를 삭제하면 첫 GC 뒤 관리자 조회에 삭제 실패가 보였고 다음 실행에서 해제됐다. 이제 예산 소진 실행은 판정을 보류하고 `blockedReason`을 바꾸지 않는다. 실제 삭제 실패는 예산 소진 없이 끝난 실행에서 기존처럼 표시된다.
- `STORIX_PORT`와 demo1 WAS의 `DEMO_WAS_PORT`가 정수가 아닌 값을 받아도 부팅하던 문제를 수정했다. `STORIX_PORT=3000abc`는 현재 디렉터리에 같은 이름의 UNIX socket 파일을 만들고 listen했고, `0x1F90`은 8080으로 listen했다. 이제 1~65535의 10진 정수(api의 `STORIX_PORT`는 `0` 포함)가 아니면 부팅을 거부한다. `0x1F90`·`1e3`·`5.0` 같은 표기를 쓰던 배포는 10진 정수로 바꿔야 한다. 컨테이너는 `STORIX_PORT: "3000"`으로 고정되어 영향이 없다.
- `POST /api/v2/namespaces`와 `PATCH /admin/namespaces/{id}/quota`가 같은 `Idempotency-Key`의 완료 요청을 재시도할 때, 전역 quota 상한(`STORIX_MAX_TOTAL_LOGICAL_BYTES`)이나 마스터 키(`STORIX_ENCRYPTION_MASTER_KEY`) 설정이 바뀌어 있으면 저장된 응답 대신 오류를 반환하던 문제를 수정했다. 이제 저장된 응답 재생과 key 재사용 충돌 판정이 이 검사보다 먼저다. `PATCH /admin/namespaces/{id}/quota`에서 없는 namespace에 전역 상한을 넘는 값을 보내면 400 `NAMESPACE_QUOTA_LIMIT_EXCEEDS_GLOBAL` 대신 404 `NAMESPACE_NOT_FOUND`를 반환한다(`PATCH .../settings`와 같은 순서).
- `GET /health/ready`의 스토리지 검사(`HeadBucket`)에 3초 timeout을 추가했다. 이전에는 스토리지가 연결만 받고 응답하지 않으면 요청이 끝나지 않고 쌓여 공유 소켓 풀을 점유했다. 이제 3초 뒤 요청을 취소하고 503으로 응답하며, 원인(`storage check timed out after 3000ms`)은 서버 로그에 남는다. 컨테이너 healthcheck(timeout 5초) 안에 응답한다. 업로드·다운로드용 S3 클라이언트의 timeout은 바뀌지 않는다.
- 디렉터리 `cp`·`rm`의 노드 수가 DB 바인드 변수 상한을 넘으면 500이던 문제를 수정했다. `STORIX_MAX_SYNC_COPY_NODES`·`STORIX_MAX_SYNC_DELETE_NODES`를 기본값(1000)보다 올린 운영자가 대상이다. `vfs_node` 1행의 INSERT가 바인드 변수 9개를 써서, SQLite는 3,641개 이상(상한 32,766)과 PostgreSQL은 7,282개 이상(상한 65,535) 노드를 복사할 때 실패했다. 삭제는 SQLite 32,767개, PostgreSQL 65,536개 이상에서 실패했다. 이제 INSERT·DELETE를 500개씩 나눠 실행한다. 삭제는 자식이 먼저 지워지도록 뒤에서부터 나눈다. 응답과 상한 환경변수의 의미는 바뀌지 않는다.
- SQLite에서 FILE snapshot 목록(`GET /api/v2/namespaces/{namespaceId}/fs/snapshots?rootNodeId=…`)의 `createdAt`이 호스트 시간대가 UTC가 아닐 때 시간대 offset만큼 어긋나던 문제를 수정했다. 시간대 없는 DB 문자열을 로컬 시간대로 해석하던 것을 UTC로 해석한다. 저장된 값은 바뀌지 않으므로 기존 데이터도 업그레이드 뒤 올바른 값으로 응답한다. PostgreSQL과 단건 조회는 영향이 없었다.
- `Idempotency-Key`를 쓰는 mutation(`POST /fs/mutations`, `POST /fs/content/conditional`, snapshot 생성·복원·삭제)에서 같은 key로 재시도하는 요청이 간헐적으로 500이던 문제를 수정했다. 이전 요청의 실패 처리(`release`)나 만료 receipt 삭제(`pruneExpired`)가 claim 도중 receipt 행을 지우면 재조회가 `EntityNotFoundError`로 끝났다. 이제 행이 사라지면 claim을 처음부터 최대 3번 시도하고, 계속 사라지면 409 `MUTATION_IN_PROGRESS`(`Retry-After: 1`)로 응답한다. 응답 코드와 계약은 바뀌지 않는다.
- 레거시 `POST /fs/content`와 `POST /fs/touch`가 storage에 올린 object를 정리하지 않던 문제를 수정했다. `POST /fs/content`는 업로드 뒤 409·404·413으로 실패해도 object가 남았다. 기존 파일에 `If-Match`·`force` 없이 최대 크기 업로드를 반복하면 매번 object가 남아, GC orphan 수거(`STORIX_ORPHAN_GRACE_PERIOD`, 기본 86400초) 전까지 quota 밖에서 storage를 점유했다. `POST /fs/touch`는 대상이 이미 있어도 빈 object를 올려 매번 orphan을 만들었고, storage 장애 때 기존 파일 `touch`도 실패했다. 이제 확정된 4xx 실패에서 Blob row가 없는 object를 삭제한다(5xx·commit 결과 불명은 보존). `POST /fs/content`는 대상 파일의 version 충돌이 확정되면(기존 파일에 `If-Match`·`force`가 없거나, `If-Match`가 현재 version과 다르거나, 대상이 없는데 `If-Match`가 있을 때) 본문을 올리기 전에 409로 거절한다. `POST /fs/touch`는 기존 파일이면 빈 object를 올리지 않는다. 응답 상태·본문은 바뀌지 않는다(GitHub 이슈 #30).
- demo1 WAS가 첫 기동 30일 이후 재기동하면 `NAMESPACE_ALREADY_EXISTS`(409)로 부팅에 실패하던 문제를 수정했다. WAS는 고정 `Idempotency-Key`로 namespace를 생성하는데, Storix가 30일 지난 receipt를 지운 뒤에는 같은 키가 새 요청이 되어 이미 있는 이름과 충돌했다. 이제 이 409를 받으면 `GET /api/v2/namespaces?limit=1000`을 `nextCursor`가 없을 때까지 순회해 이름과 `accessPolicy`가 같은 namespace의 id를 쓴다. 일치하는 namespace가 없으면 원래 409로 실패한다. 이름 조회 API가 없어 목록 전체를 훑으므로 namespace 수가 많은 인스턴스에는 맞지 않는다. API 동작·계약은 바뀌지 않는다(GitHub 이슈 #29).
- 레거시 `POST /fs/content`가 `If-Match`를 대상 파일이 없을 때와 `force=true`일 때 무시하던 문제를 수정했다. 문서(`openapi.yaml`)는 "값이 있는데 현재 version과 다르면 409"였다. 이제 `If-Match`가 있으면 대상이 없어도(`VFS_VERSION_CONFLICT`, 파일을 만들지 않는다), `force=true`여도 현재 version과 비교한다. 정수가 아닌 값(`*`, `W/"3"`, `r1.…`, 복수 값, `0x10` 같은 비10진 표기)은 이전에 "헤더 없음"으로 처리됐으나 이제 업로드 전에 409로 거절한다. 빈 `If-Match`는 이전처럼 헤더 없음으로 본다. 이전에 성공하던 요청이 409로 바뀐다. 다른 사용자가 지운 파일을 `If-Match`로 저장하면 되살아나던 동작과, `If-Match`를 보낸 `force=true` 요청이 version과 무관하게 덮어쓰던 동작이 해당한다. `If-Match` 없이 `force=true`로 덮어쓰는 호출과 `/fs/content/conditional`은 바뀌지 않는다(GitHub 이슈 #25).
- `STORIX_RESTORE_FORCE=true` 복구가 Postgres 복구보다 먼저 스토리지 object를 전부 지워, `pg_restore`가 실패하면 버킷이 빈 채로 남던 문제를 수정했다. 이제 Postgres 복구 → 백업 object put → 백업에 없는 object 삭제 순서다. Postgres 복구가 실패하면 object를 변경하지 않으므로 원인을 고치고 같은 백업으로 재실행하면 된다. 삭제 단계가 실패하면 복구는 실패로 끝나며 재실행하면 이어서 처리한다. SQLite 드라이버도 같은 순서를 따른다(GitHub 이슈 #24).
- `HEAD`를 `fs` content·download, `public` content·download, snapshot content에 보내면 서버가 Blob(ENCRYPTED는 복호화 stream 포함)을 끝까지 읽은 뒤 버리던 문제를 수정했다. 공개 경로에서는 무인증 요청으로 매번 storage 전송을 일으킬 수 있었다. 이제 Blob을 열지 않고 GET과 같은 응답 헤더만 보낸다. `Range`가 있으면 206과 `Content-Range`, 잘못된 범위는 416으로 GET과 같다. ENCRYPTED namespace의 HEAD는 마스터 키를 요구하지 않는다. HEAD는 `openapi.yaml`에 없는 동작이며 이 변경도 문서화하지 않는다(GitHub 이슈 #23).
- SQLite 드라이버에서 `SQLITE_FULL`·`SQLITE_IOERR` 등으로 SQLite가 트랜잭션을 스스로 롤백하면 쿼리 게이트가 해제되지 않아 프로세스를 재시작할 때까지 모든 쿼리가 30초 대기 뒤 503 `DB_BUSY`로 실패하던 문제를 수정했다. 게이트가 트랜잭션·SAVEPOINT 깊이를 직접 세어 최상위 트랜잭션이 끝나면 해제한다. 중첩 트랜잭션이 자동 롤백된 뒤 바깥 콜백이 오류를 삼키고 쿼리를 이어 보내면 autocommit으로 실행하지 않고 내부 오류(`SqliteTransactionAbortedError`, 미분류 500)로 실패시킨다. `ROLLBACK` 재시도에도 트랜잭션이 남으면 게이트를 해제하지 않고 error 로그를 남긴다. 이 경우 프로세스 재시작이 필요하다. PostgreSQL에는 영향이 없다(GitHub 이슈 #22).
- 감사 로그의 `detail`에 짝이 맞지 않는 UTF-16 surrogate가 들어가면 PostgreSQL `jsonb` INSERT가 실패해 해당 요청의 감사 행이 사라지던 문제를 수정했다. 입력의 lone surrogate는 `U+FFFD`로 기록하고, 4096 코드 유닛 경계가 surrogate pair 중간이면 그 글자를 버린다. 같은 정리를 `path`에도 적용한다.
- 기본 compose가 `gc`에 `STORIX_GC_MAX_ROWS_PER_STAGE`·`STORIX_NAMESPACE_DELETED_RETENTION_DAYS`를, `app`에 `STORIX_MAX_SYNC_SNAPSHOT_NODES`·`STORIX_MAX_SNAPSHOT_BYTES`·`STORIX_MAX_RETAINED_SNAPSHOT_NODES`·`STORIX_MAX_RETAINED_SNAPSHOT_BYTES`·`STORIX_MUTATION_LEASE_SECONDS`·`STORIX_MUTATION_MAX_UPLOAD_SECONDS`·`STORIX_VFS_EXPIRY_MIN_SECONDS`·`STORIX_VFS_EXPIRY_MAX_SECONDS`를 전달하지 않아 `.env`의 값이 무시되고 코드 기본값으로 동작하던 문제를 수정했다. 기본값은 코드와 같다.
- 기본 compose가 `STORIX_SENTRY_DSN`을 `app`·`gc`·`backup`·`restore`에 전달하지 않아 `.env`에 적어도 Sentry 리포팅이 켜지지 않던 문제를 수정했다. 값이 비어 있으면 기존처럼 리포팅하지 않는다. README 변수표에서 `STORIX_STORAGE_PUBLIC_*`의 "읽는 곳"을 `app`으로 고쳤다. gc·backup·restore는 presigned URL을 발급하지 않아 전달하지 않는다. `STORIX_VFS_CAPABILITIES_CONFIG_PATH`·`STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`는 컨테이너 안 파일 경로가 필요해 기본 compose가 전달하지 않는다. override에서 경로와 volume을 함께 지정하도록 README에 적었다(GitHub 이슈 #20).
- PostgreSQL에서 `X-Request-Id`·`Content-Type`·`Idempotency-Key`의 길이가 DB 컬럼을 넘으면 500이 나고 SQLite는 성공하던 문제를 수정했다. 업로드 세션 `request_id`·`creation_request_id` 컬럼을 `varchar(200)`으로 넓혀(PostgreSQL 마이그레이션, SQLite는 건너뜀) 129~200자 `X-Request-Id`로 업로드 세션 생성·완료가 되도록 했다. `Content-Type`은 `;` 뒤를 뗀 값이 255자를 넘으면 `application/octet-stream`으로 저장한다. `POST /namespaces`는 255 byte를 넘는 `Idempotency-Key`를 400 `IDEMPOTENCY_KEY_REQUIRED`로 거절한다. SQLite에서 256 byte 이상 키로 namespace를 만들던 요청은 이제 400이다. openapi `IdempotencyKeyHeader`에 `maxLength: 255`를 추가했다. 결정은 api ADR-0041이다.
- 조건부 업로드(`POST /fs/content/conditional`)에서 commit 결과가 불명확한 오류(commit은 성공했으나 응답이 유실된 경우)가 나면 업로드한 object를 삭제해 공개 파일의 GET이 실패하던 문제를 수정했다. commit 결과가 불명확하거나 Blob row 참조 확인에 실패하면 object를 보존하고 orphan GC에 맡긴다.
- PostgreSQL에서 `ls`·`find`·snapshot 목록의 cursor와 `find`의 `name`이 유효하지 않으면 500이 나던 문제를 수정했다. 이제 400이다. 영향을 받은 입력은 UUID가 아닌 `id`나 NUL이 든 `name`을 담은 `ls`·`find` cursor, 존재하지 않는 날짜(`2026-02-30`)와 `0000`년을 담은 snapshot 목록 cursor, 중복되거나 NUL이 든 `find` `name`이다. cursor는 `VFS_INVALID_CURSOR`, `name`은 `VFS_INVALID_QUERY`다. SQLite도 같은 입력을 400으로 거절한다.
- PostgreSQL에서 `GET /api/v2/namespaces`의 `nl1.` cursor에 NUL이 든 `name`을 담으면 500이 나던 문제를 수정했다. 이제 400 `VFS_INVALID_CURSOR`다. `name`이 namespace name 문법(`^[a-z0-9_-]{1,128}$`)이 아니면 같은 400이다. 서버가 만든 cursor는 항상 이 문법을 만족하므로 정상 순회는 바뀌지 않는다. SQLite도 같은 입력을 400으로 거절한다.
- PostgreSQL에서 `GET /fs/ls?consistency=revision`의 `rc1.` cursor에 NUL이 든 `name`을 담으면 500이 나던 문제를 수정했다. 이제 400 `VFS_INVALID_CURSOR`다. 서버가 만든 cursor의 `name`은 저장된 노드 이름이라 NUL이 없으므로 정상 순회는 바뀌지 않는다. SQLite도 같은 입력을 400으로 거절한다.
- `PATCH /admin/namespaces/{id}/quota`와 `PATCH /admin/namespaces/{id}/trash`가 255 byte를 넘는 `Idempotency-Key`를 받아들이던 것을 openapi `maxLength: 255`에 맞춰 400 `IDEMPOTENCY_KEY_REQUIRED`로 거절한다. 이전에 성공하던 256 byte 이상 키는 400이 된다. 두 경로는 키를 해시해 저장하므로 서버 오류는 없었다. `PATCH /namespaces/{id}/settings`와 `POST /admin/namespaces/{id}/delete`의 오류 코드는 그대로다.
- `openapi.yaml`이 live Node 수·폴더 파일 수·논리 quota 상한 초과 413(`VFS_NAMESPACE_NODE_LIMIT_EXCEEDED`·`VFS_FOLDER_FILE_LIMIT_EXCEEDED`·`VFS_QUOTA_EXCEEDED`)을 operation에 적지 않던 문제를 고쳤다. `mkdir`·`touch`·`mv`·휴지통 `restore`에는 `413` 응답을 추가했고, `cp`·`content`·`content/conditional`·`mutations`·업로드 세션 `complete`·snapshot 생성·snapshot `restore`는 설명에 누락된 코드를 더했다. 서버 동작은 바뀌지 않는다(GitHub 이슈 #16).
- SQLite에서 재귀 `rm`·`cp`가 노드 수에 O(N²)로 느려지던 문제를 수정했다. 하위 노드를 모으는 재귀 CTE가 `namespace_id` 인덱스를 골라 큐 행마다 namespace 전체를 훑었다. 평평한 디렉터리 12,000개를 SQLite 메모리 DB에서 지울 때 5.3초이던 것이 0.1초로, 복사할 때 6.7초이던 것이 1.4초로 줄었다. 노드 수에 선형으로 늘어난다. 결과와 공개 계약은 바뀌지 않는다. PostgreSQL의 12,000개 `cp`는 약 20초로 수정 전후가 같다. 원인은 이 CTE가 아니며 조사하지 않았다. 함정은 `docs/traps/TRP-007`에 기록했다.
- 같은 FILE에 `POST /fs/touch`를 직전 쓰기와 같은 밀리초 안에 다시 보내면 200을 응답하면서 FILE version이 오르지 않던 문제를 수정했다. 응답 revision이 이전 값과 같았고 change feed에 파일 `updated` 이벤트가 남지 않았다. 이제 touch는 매번 version을 1 올린다. 함정은 `docs/traps/TRP-010`에 기록했다(GitHub 이슈 #40).

### Security

- `pg_dump`·`pg_restore`가 `STORIX_*` 비밀 환경변수를 상속하지 않는다. 허용 목록(`PATH`, `HOME`, `TZ`, `LANG`, `LC_*`, `PG*`)만 넘긴다. 이 이름 밖의 변수(`SSL_CERT_FILE`, `LD_LIBRARY_PATH` 등)로 libpq를 설정한 운영 환경은 그 값이 자식에 전달되지 않는다.
- `STORIX_SENTRY_DSN`을 설정한 배포에서 오류 이벤트가 `Authorization` 헤더 원문(Bearer API 키)을 Sentry로 전송하던 문제를 수정했다. v1.1.0을 포함한 이전 버전이 영향을 받는다. 오류 이벤트 전송 직전에 `request.headers.authorization`을 지운다. 영향을 받은 배포는 Sentry에 남은 이벤트를 삭제하고 `STORIX_API_KEY`·`STORIX_ADMIN_API_KEY`를 교체한다.
- 인증 거부(401) 감사 행이 요청 수에 비례해 무제한으로 쌓이던 문제를 수정했다. 키가 없거나 잘못된 요청마다 `audit_log`에 행을 insert했고 `path`는 길이 제한 없이 저장됐다. 이제 프로세스당 60초에 60행까지만 기록한다. 초과분은 건수만 세고 다음 윈도의 첫 거부 때 요약 행 1개(`operation='AUTH_REJECT_SUPPRESSED'`, `detail={suppressed, windowSeconds}`)로 남긴다. 윈도당 첫 생략 때 경고 로그를 한 번 남긴다. 401 `path`는 4096 코드 유닛까지만 저장한다. 마지막 윈도의 요약 행은 다음 거부가 올 때까지 기록되지 않는다. 상한은 인스턴스별이며 환경변수로 바꿀 수 없다. `audit_log`의 보존 정책은 이 변경에 없다. api ADR-0010의 "알려진 한계"를 현재 동작에 맞게 고쳤다(GitHub 이슈 #28).

### Fixed

- Namespace ID·제한 상속·휴지통 기본 정책·quota 제외와 Postgres 서버/client 버전과 백업 일관성의 문서 설명을 현재 구현에 맞췄다. 데모 검증 문서의 깨진 링크를 수정했다.

## [1.1.0] - 2026-10-02

### Added

- 폴더별 직접 자식 `FILE` 수 상한을 추가했다. 기본값은 `STORIX_DEFAULT_MAX_FILES_PER_FOLDER=10000`이고 `STORIX_MAX_FILES_PER_FOLDER`가 전역 ceiling이다. migration `AddFolderFileCount1791700000018`은 기존 폴더 counter를 backfill하며, 초과 생성은 413 `VFS_FOLDER_FILE_LIMIT_EXCEEDED`로 거부한다.
- namespace의 root를 제외한 live `FILE`·`DIRECTORY` 수 상한을 추가했다. 기본값은 `STORIX_DEFAULT_MAX_LIVE_NODES=1000000`이고 `STORIX_MAX_LIVE_NODES`가 전역 ceiling이다. migration `AddLiveNodeCount1791700000019`가 기존 수를 backfill하며, 상한 초과 생성은 413 `VFS_NAMESPACE_NODE_LIMIT_EXCEEDED`로 거부한다. namespace 삭제 GC도 counter를 배치별 정산한다.
- namespace quota에서 휴지통·snapshot 보존 바이트를 각각 제외하는 설정과, 제외된 휴지통의 보존 바이트 상한을 추가했다. migration `AddQuotaExclusion1791700000020`을 적용한다. `quota.usedBytes`는 총량을 유지하고, 응답에 `liveBytes`, `trashBytes`, `snapshotBytes`, `enforcedBytes`, 제외 플래그와 유효 상한을 추가했다. 휴지통 바이트 상한 초과는 413 `VFS_TRASH_LIMIT_EXCEEDED`다.
- 관리자용 `PATCH /api/v2/admin/namespaces/{namespaceId}/settings`를 추가했다. namespace의 quota·파일 크기·폴더 파일 수·live node 수·휴지통 바이트 상한과 quota 제외·휴지통 사용 설정을 한 요청에서 부분 변경하며, 설정 ceiling과 `Idempotency-Key`를 적용한다.

- Namespace 생성에서 `name`을 생략하거나 `null`로 지정할 수 있다. 응답의 `name`은 항상 존재하며 미지정이면 `null`이다. 목록은 이름 있는 항목을 `(name, id)` 순으로 반환하고 이름 없는 항목을 뒤에 `id` 순으로 반환한다. migration `MakeNamespaceNameNullable1791700000017`이 nullable 제약과 이름 없는 항목용 인덱스를 추가한다. 이름 없는 행이 있으면 migration down을 거부한다.
- Namespace ID 생성 시 선택 필드 `idPrefix`를 지원한다. ID는 기존 UUID 또는 `{prefix}_{UUID v4의 하이픈 제거 32자리}` 형식이다. UUID 타입으로만 파싱하는 클라이언트는 새 형식을 처리하도록 수정해야 한다. capability·resumable upload namespace 설정도 새 형식을 받으며 대소문자·하이픈 변형은 별칭으로 취급하지 않는다. migration `ConvertNamespaceIdToString1791700000016`은 PostgreSQL namespace 참조 컬럼을 `varchar(45) COLLATE "C"`로 바꾸고 `vfs_upload_usage.id`를 `varchar(64)`로 확장한다. SQLite는 `varchar` 길이를 제한하지 않으므로 새 migration은 타입 변경이 없다. 새 ID가 만들어진 뒤 migration down은 UUID 형식이 아닌 참조가 남아 있으면 거부된다.
- `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`(기본 `30`): 삭제가 끝난(`DELETED`) namespace의 행을 gc가 물리 삭제하기까지의 보존 기간이다. 완료 시점부터 이 기간이 지나면 namespace·삭제 operation·삭제 receipt 행을 지운다(GC 결과 `purgedNamespaces`). 이후 `GET /api/v2/namespaces/{id}`·삭제 상태 조회·같은 key의 삭제 재요청은 404 `NAMESPACE_NOT_FOUND`다(보존 기간 안에서는 `DELETED` 상태 응답과 최초 202 재생). 물리 삭제는 되돌릴 수 없고 복구에는 삭제 전 백업이 필요하다. 설정(`STORIX_VFS_CAPABILITIES_CONFIG_PATH`)에 적은 namespace가 물리 삭제되면 시작이 거부되므로 삭제한 namespace는 설정에서 지운다. migration `AddNamespaceDeletionCompletedIndex1791700000015`(인덱스만 추가)가 필요하다. 결정은 api ADR-0035다.
- `GET /api/v2/namespaces`의 page 모드: `limit`(기본 100·최대 1000)·`cursor`를 주면 `{ items, nextCursor }`를 `(name, id)` 순서의 keyset으로 반환한다. 잘못된 cursor는 400 `VFS_INVALID_CURSOR`다. 100만 namespace에서 첫 page가 9ms, 전체 순회(page 1000개)가 11.5s·API RSS 416MiB다. 이전 계약의 전체 배열은 100만 개에서 응답 364MiB·9.8s·RSS 2.6GiB였다.
- capability 설정 파일의 선택 키 `defaultEnabledCapabilities`: `namespaceAllowedCapabilities`에 항목이 없는 모든 namespace(설정 이후 만든 namespace 포함)에 켤 capability 목록이다. 전역 허용이 최종 상한이고 namespace 항목이 있으면 그 값이 기본 목록을 대신한다(빈 목록은 비활성). 키가 없으면 이전 동작과 같다. 회원마다 namespace를 만드는 배포가 namespace를 설정에 나열하거나 재시작하지 않아도 된다.
- `STORIX_GC_MAX_ROWS_PER_STAGE`(기본 `200000`): GC가 한 실행에서 단계마다 처리하는 행 수 예산이다. 소진된 단계는 재개 위치를 `gc_cursor` 테이블에 저장하고 다음 실행이 이어간다. 대상 단계는 change feed 보존 정리, orphan object·blob 회수, 만료 session·staging 정리, 파일 만료 삭제, namespace 삭제 순회, receipt·휴지통 prune이다. GC 결과 JSON에 예산이 소진된 단계를 알리는 `budgetExhaustedStages`가 추가됐다.

### Deprecated

- `limit`·`cursor` 없이 호출하는 `GET /api/v2/namespaces`(ACTIVE 전체 배열). 동작은 그대로이고 개수에 상한이 없다. 새 호출자는 page 모드를 쓴다.

### Changed

- 폴더별 FILE counter migration이 backfill 중 `(parent_id, type)` 임시 인덱스를 사용한다. PostgreSQL 16 scale 하네스의 10만 namespace 측정에서 migration 전체 시간이 237초 이상 진행 후 취소된 상태에서 10.78초로 줄었다. 환경별 migration 시간은 다를 수 있다.

- `STORIX_DEFAULT_TOTAL_LOGICAL_BYTES`·`STORIX_DEFAULT_FILE_SIZE_BYTES`와 `STORIX_MAX_TOTAL_LOGICAL_BYTES`·`STORIX_MAX_FILE_SIZE_BYTES`를 분리했다. MAX만 지정하면 이전처럼 기본값과 ceiling이 같고, DEFAULT만 지정하면 기본값 아래·위 namespace override를 허용하며 ceiling은 구조 상한으로 제한한다. 시작 시 DEFAULT가 ceiling을 넘거나 파일 크기 ceiling이 S3 multipart 구조 상한(16 MiB × 10,000 parts)을 넘으면 거부한다.

- namespace 생성(201·이름 충돌 409)과 관리 API(quota, trash 정책)의 `Idempotency-Key` receipt(`idempotency_key`)를 생성 시점부터 30일 보존한 뒤 GC가 지운다(GC 결과 `prunedIdempotencyReceipts`). 이전에는 영구 보존이었다. 30일이 지난 key의 재요청은 최초 응답을 재생하지 않고 새 요청으로 처리된다: 생성은 이름이 비어 있으면 새 namespace(201), 있으면 409이고, 같은 key에 다른 본문도 422가 아니다. 100만 namespace 데이터셋에서 receipt 140만 행을 지우는 데 약 30초가 걸린다. migration `AddIdempotencyKeyCreatedAtIndex1791700000014`(인덱스만 추가)가 필요하다. 삭제한 행은 백업 복원 외에 되돌릴 수 없다. 결정은 api ADR-0034다.
- 업로드 세션 정책 파일의 `namespaces` 항목은 선택 override가 됐다. `resumable-upload`가 켜진 namespace의 항목이 없으면 전역 `maxStagedBytes`·`maxActiveSessions`를 쓴다. 이전에는 시작 오류(`Missing upload session policy for enabled namespace`)였다.
- API 시작 시 `ENCRYPTED` namespace 존재 확인이 전체 `COUNT` 대신 `EXISTS`로 바뀌었다. 마스터 키가 없는 배포의 시작이 namespace 수에 비례해 읽던 비용을 없앤다. 부분 인덱스 `idx_namespace_encrypted`를 만드는 migration `AddNamespaceEncryptedIndex1791700000013`이 추가된다. down은 인덱스만 지운다.
- capability 설정의 namespace 존재 확인을 항목마다 조회하지 않고 일괄 조회한다(PostgreSQL 1회, SQLite 1000개씩). 존재하지 않는 namespace를 적으면 시작을 거부하는 동작은 그대로다. 활동 namespace 10만 개를 설정에 나열한 API 시작이 24.9s에서 1.2s가 됐다(100만 namespace 데이터셋 측정).
- GC가 metadata 없는 object를 찾을 때 storage 목록을 page(1000개)씩 읽고 그 page의 key만 DB 인덱스로 대조한다. 전체 `storage_key` 집합과 삭제 대상 목록을 메모리에 모으던 방식을 없앴다. 100만 namespace·object 약 51.5만 개 데이터셋에서 GC 프로세스가 이전에는 Node heap 상한 96MB에서 종료했고 지금은 48MB에서 통과한다. orphan blob 후보도 `(zero_since, id)` keyset으로 500개씩 읽는다. 삭제 규칙(grace period, 삭제에 성공한 object의 행만 삭제, staging 보호)은 그대로다.
- GC가 처리 후보가 없을 때까지 batch를 끝없이 반복하던 단계(만료 session·staging 정리, 파일 만료 삭제, mutation receipt·terminal session·휴지통 prune, stale finalizing lease 복구, namespace 삭제 순회)가 단계 예산 안에서 batch를 이어 돌고 예산이 소진되면 다음 실행으로 넘긴다. 이전에는 receipt·terminal session prune과 만료 session 처리가 실행당 500건에서 멈췄다.
- change feed 보존 정리의 후보 선택을 만료 이벤트 인덱스 순서 cursor로 바꿨다. 선두 이벤트가 유효한 namespace의 만료 이벤트가 많을 때 GC가 호출마다 그 이벤트를 다시 건너뛰던 비용을 없앴다(100만 namespace·막힌 이벤트 27,000개 구성에서 GC 84.4s → 4.8s). 삭제 규칙(만료된 연속 prefix만 삭제)은 그대로다. migration `AddGcCursor1791700000012`(새 테이블 `gc_cursor`)이 추가된다. down은 테이블을 지우며 저장된 재개 위치만 잃는다.

- 이미지의 `pg_dump`·`pg_restore` client major를 빌드 인자 `PG_CLIENT_MAJOR`로 정한다. 기본값은 16에서 17로 바뀌었다. 서버 major와 client major가 같아야 하며, client가 낮으면 `backup`이 `server version mismatch`로, 높으면 `restore`가 `transaction_timeout` 오류로 실패한다. Postgres 16 서버는 `-pg16` 이미지(`ghcr.io/cp949/storix:vX.Y.Z-pg16`)나 `--build-arg PG_CLIENT_MAJOR=16`을 쓴다. `docker-compose.postgres.yml`의 개발용 Postgres도 17이다. 17 서버에서 계약 70개와 backup·restore(실스택)가 통과한다. 지원 범위는 선언하지 않는다. 결과는 `docs/deployment/postgres-versions.md`, 결정은 api ADR-0039다.

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
