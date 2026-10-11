# 선택 FILE archive

## 공개 계약

`POST /api/v2/namespaces/{namespaceId}/fs/archive`는 같은 namespace의 FILE ID 목록을 ZIP FILE로 저장한다. 요청의 `target`은 새 FILE 경로이고 `entries`는 순서가 있는 `{ id, name, revision? }` 목록이다. revision은 선택 조건이며 capture 시점 값과 달라지면 412다.

요청의 FILE 수 상한은 기본 1000개이며 설정으로 최대 65534개까지 허용한다. 최소 1개 FILE이 필요하다. 평문 원본 합계는 최대 1 GiB, ZIP 결과는 ZIP 구조를 포함해 최대 2 GiB, JSON 본문은 최대 8 MiB다. 실제 FILE 수·평문 byte 상한은 실행 설정을 따른다. 운영 상한은 측정 없이 올리지 않는다. 같은 FILE을 다른 이름으로 여러 번 넣을 수 있고 각각 FILE 수와 평문 합계에 센다.

ZIP 내부 이름은 UTF-8 NFC 상대 경로다. 전체 4095 byte, segment 255 byte 이하이며 제어·Bidi 문자, 빈 segment, `.`/`..` segment, 선행 `/`, `\`, drive prefix를 거부한다. 입력 순서를 유지하고 동일 이름과 다른 entry의 조상 디렉터리와 같은 이름을 거부한다. OS별 이름 변환은 하지 않는다.

성공은 201 JSON이며 `resource`는 `application/zip` FILE metadata(revision·평문 size·sha256·expiresAt 포함), `entryCount`는 capture한 항목 수다. 바이트는 기존 content API로 받는다. `Idempotency-Key`와 `X-Mutation-Scope`는 필수이고 `X-Expires-In`은 선택이다. 기본 capability는 비활성이며 capability 설정 파일의 전역 허용과 namespace 허용이 모두 필요하다.

## 오류와 receipt

| 상태·코드                                                                      | 조건                                                     | receipt |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- | ------- |
| 400 `VFS_INVALID_ARCHIVE_REQUEST`                                              | 구조·UUID·이름 오류, 빈 목록, 같은 namespace의 DIRECTORY | 저장    |
| 400 `VFS_INVALID_REVISION` (`archiveEntry`)                                    | revision 형식 오류 또는 id 불일치                        | 저장    |
| 400 `VFS_INVALID_PATH`, `VFS_INVALID_EXPIRY`                                   | target 경로 오류, 만료 입력 오류                         | 저장    |
| 400 `VFS_INVALID_MUTATION_REQUEST`                                             | `Idempotency-Key`·`X-Mutation-Scope` 누락·형식 오류      | 없음    |
| 404 `NAMESPACE_NOT_FOUND`                                                      | namespace 비활성                                         | 없음    |
| 404 `VFS_NODE_NOT_FOUND` (`archiveEntry`, `path` 없음)                         | 원본 부재·다른 namespace·휴지통                          | 저장    |
| 404 `VFS_NODE_NOT_FOUND` (`path`)                                              | target 부모 디렉터리 부재                                | 저장    |
| 409 `VFS_FEATURE_DISABLED`                                                     | capability 비활성                                        | 없음    |
| 409 `MUTATION_IN_PROGRESS` (Retry-After), `MUTATION_KEY_REUSED`                | 같은 key가 RESERVED, 같은 key에 다른 fingerprint         | 없음    |
| 409 `VFS_NOT_DIRECTORY`                                                        | target 조상 경로가 FILE                                  | 저장    |
| 412 `VFS_PRECONDITION_FAILED` (`archiveEntry`, 원본 FILE의 VFS 경로·`current`) | 원본 revision 불일치                                     | 저장    |
| 412 `VFS_PRECONDITION_FAILED` (`archiveEntry` 없음, target 노드 `current`)     | target 존재(FILE·DIRECTORY 모두)                         | 저장    |
| 413 `VFS_ARCHIVE_TOO_LARGE`, `VFS_FILE_TOO_LARGE`, `VFS_QUOTA_EXCEEDED`        | FILE 수·원본 합계·ZIP 결과 상한, FILE 상한, quota 부족   | 저장    |
| 413 `BAD_REQUEST`                                                              | 8 MiB 본문 초과(fingerprint 전)                          | 없음    |
| 503 `VFS_ARCHIVE_BUSY` (Retry-After)                                           | 프로세스 gate 포화                                       | 없음    |
| 503 `VFS_ARCHIVE_TIMEOUT`                                                      | capture부터 commit까지의 deadline 경과                   | 없음    |
| 5xx                                                                            | 원본 소실·무결성 불일치·DB·storage 장애                  | 없음    |

`archiveEntry`는 실패한 `entries` 배열의 0부터 시작하는 index다. 저장되는 오류는 같은 key·같은 fingerprint에서 30일간 재생되므로 상태나 입력을 고친 뒤에는 새 key를 쓴다. 저장하지 않는 응답 뒤에는 같은 key로 다시 평가한다. 원본 부재 404는 부재·다른 namespace·휴지통을 구분하지 않는다. 오류 우선순위는 구조 검증(400) → target 조건(404·409·412) → entry 순서대로의 원본 검증이다. 완료 receipt 재생은 capability·gate·원본 상태를 다시 검사하지 않는다.

## 실행과 실패 경계

Capture는 source metadata와 target 조건을 한 DB snapshot에서 확인한다. 원본 Blob 참조 수는 바꾸지 않는다. 각 source stream의 평문 길이와 SHA-256을 ZIP writer 앞에서 확인한다. 누락·무결성 오류·취소·deadline·quota 오류는 target FILE을 만들지 않는다. 실패한 업로드 object는 확정된 4xx면 즉시 지우고, 5xx·취소면 orphan GC에 맡긴다. 취소된 multipart PUT은 `AbortMultipartUpload`를 보내 조각을 바로 정리하며, 프로세스가 그 전에 죽으면 GC가 회수한다.

취소 신호는 capture 종료, 업로드 완료, lease 갱신 뒤와 최종 transaction의 FILE 등록·receipt 완료 SQL 전에 검사한다. 검증·복호화·S3 응답 wrapper는 내부 source의 비동기 destroy callback 완료까지 기다린다. Writer 정착 뒤에 gate 슬롯을 반환한다.

ZIP writer는 순차 DEFLATE/STORED 기록, data descriptor, central directory를 직접 작성한다. Zip64와 빈 디렉터리는 지원하지 않는다. 결과 상한은 ZIP 구조 전체 byte를 포함한다. 기본 압축 수준은 1이다.

Gate는 API 프로세스 내부 동시 실행 수(기본 1)만 제한한다. 분산 공정성이나 cluster 전체 한도는 제공하지 않는다. 포화 요청은 503과 `Retry-After`(기본 10초)를 받는다. 요청 처리 전에 이미 끊긴 client는 원본을 읽지 않고 gate 슬롯과 claim을 바로 돌려준다.

## 원본 보존 전제

Archive는 영속 read hold를 만들지 않는다. 운영자는 모든 API와 GC 실행에 같은 `STORIX_ORPHAN_GRACE_PERIOD`를 적용해야 한다. 진행 중 archive 동안 grace를 줄이지 않아야 한다. API는 `STORIX_ARCHIVE_MAX_SECONDS + 60 <= STORIX_ORPHAN_GRACE_PERIOD`만 검사한다. `archive`가 `globalAllowedCapabilities`에 있으면 위반 시 시작을 거부하고, 없으면 경고만 남긴다. 60초 여유는 가정이다.

DB 삭제 transaction 지연 상한과 GC 호스트 시계 오차는 측정하지 않는다. 이 부팅 검사는 원본 보존 보증이 아니다. 더 강한 보존이 필요하면 삭제 지연 예산을 검증하거나 read hold를 설계한다.

## 운영

동기 요청은 기본 최대 600초다. 프록시와 호출자는 archive 최대 시간에 응답 전송 여유를 더한 timeout을 설정해야 한다. nginx 기본 `proxy_read_timeout`은 60초라 기본 상한보다 짧다. 저장소의 nginx 샘플은 timeout을 지정하지 않으므로 archive를 쓰는 배포는 직접 지정한다.

SIGTERM drain은 `STORIX_SHUTDOWN_TIMEOUT_SECONDS`(기본 25초)를 따른다. 기본값은 archive 상한보다 짧아 진행 중 archive가 끊긴다. 끊기지 않게 하려면 drain 상한과 compose `stop_grace_period`를 archive 상한 이상으로 올리거나, 배포 전에 archive capability를 끄고 상한만큼 기다린다. 프로세스 종료로 receipt가 RESERVED로 남으면 lease(기본 60초)가 유효한 동안 409 `MUTATION_IN_PROGRESS`와 `Retry-After`를 받는다. 만료 뒤 같은 key로 재시도해 takeover한다. 완료 receipt 재생과 구분한다.

실제 GC 프로세스 설정, 배포 proxy timeout, 운영 storage 동작은 이 문서로 검증되지 않는다.
