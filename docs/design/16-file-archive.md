# 선택 FILE archive

## 공개 계약

`POST /api/v2/namespaces/{namespaceId}/fs/archive`는 같은 namespace의 FILE ID 목록을 ZIP FILE로 저장한다. 요청의 `target`은 새 FILE 경로이고 `entries`는 순서가 있는 `{ id, name, revision? }` 목록이다. revision은 선택 조건이며 capture 시점 값과 달라지면 412다.

요청은 1~1000개 FILE, 평문 원본 합계 최대 1 GiB, JSON 본문 최대 8 MiB다. 실행 설정은 더 낮은 상한을 둘 수 있다. ZIP 내부 이름은 UTF-8 NFC 상대 경로다. 입력 순서를 유지하고 동일 이름과 FILE/부모 충돌을 거부한다. OS별 이름 변환은 하지 않는다.

성공은 201 JSON이며 `resource`는 `application/zip` FILE metadata, `entryCount`는 capture한 항목 수다. 바이트는 기존 content API로 받는다. `Idempotency-Key`와 `X-Mutation-Scope`는 필수다. 성공 receipt는 같은 요청에서 결과를 재생하며 입력 변경은 409다. 기본 capability는 비활성이다.

## 실행과 실패 경계

Capture는 source metadata와 target 조건을 한 DB snapshot에서 확인한다. 원본 Blob 참조 수는 바꾸지 않는다. 각 source stream의 평문 길이와 SHA-256을 확인한다. 누락·무결성 오류·취소·deadline·quota 오류는 target FILE을 만들지 않는다.

ZIP writer는 순차 DEFLATE/STORED 기록, data descriptor, central directory를 직접 작성한다. Zip64와 빈 디렉터리는 지원하지 않는다. 결과 상한은 ZIP 구조 전체 byte를 포함한다.

Gate는 API 프로세스 내부 동시 실행 수만 제한한다. 분산 공정성이나 cluster 전체 한도는 제공하지 않는다. 포화 요청은 503과 `Retry-After`를 받는다.

## 원본 보존 전제

Archive는 영속 read hold를 만들지 않는다. 운영자는 모든 API와 GC 실행에 같은 `STORIX_ORPHAN_GRACE_PERIOD`를 적용해야 한다. 진행 중 archive 동안 grace를 줄이지 않아야 한다. API는 `STORIX_ARCHIVE_MAX_SECONDS + 60 <= STORIX_ORPHAN_GRACE_PERIOD`만 검사한다. 60초 여유는 가정이다.

DB 삭제 transaction 지연 상한과 GC 호스트 시계 오차는 측정하지 않는다. 이 부팅 검사는 원본 보존 보증이 아니다. 더 강한 보존이 필요하면 삭제 지연 예산을 검증하거나 read hold를 설계한다.

## 운영

동기 요청은 기본 최대 600초다. SIGTERM drain은 `STORIX_SHUTDOWN_TIMEOUT_SECONDS`를 따른다. 프록시·호출자는 archive 최대 시간과 응답 전송 여유를 포함한 timeout을 설정해야 한다. 프로세스 종료로 receipt가 RESERVED로 남으면 lease가 유효한 동안 409 `MUTATION_IN_PROGRESS`와 `Retry-After`를 기다린다. 만료 뒤 같은 key로 재시도해 takeover한다. 완료 receipt 재생과 구분한다.

실제 GC 프로세스 설정, 배포 proxy timeout, 운영 storage 동작은 이 문서로 검증되지 않는다.
