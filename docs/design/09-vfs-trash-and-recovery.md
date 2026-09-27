# VFS 휴지통과 삭제 복구

## 상태와 수명

현재 live node의 `revision`은 조건부 변경을 위한 불투명 비교 토큰이며 과거 본문 이력이 아니다. 과거 바이트를 독립적으로 보존하려면 FILE 또는 TREE snapshot을 명시적으로 만든다. 일반 삭제는 한 파일 또는 한 디렉터리 subtree를 휴지통 manifest 한 건으로 옮긴다. Manifest는 원래 node ID·revision·상대 경로·유형·파일 metadata·Blob 참조와 원래 root 경로를 가진다. 삭제된 live 경로는 즉시 비워지므로 같은 경로에 새 node를 만들 수 있다.

각 항목의 `deletedAt`은 DB 시각이며 `expiresAt`은 30일 뒤다. `GET /fs/trash`는 미만료 항목만 `deletedAt DESC, trashId ASC` keyset cursor로 열거한다. 만료 뒤 복구는 GC 전에도 410이다. 없는 ID나 다른 namespace ID는 404다. 만료 시각은 검사 시점의 DB 시각과 비교한다.

## 복구와 영구 삭제

복구는 원래 경로 또는 명시한 `targetPath`에 manifest 전체를 되살린다. 원래 node ID와 subtree 구조를 유지하고 모든 node에 새 revision을 발급한다. 복구 경로의 부모가 없거나 대상이 이미 있으면 전체 변경을 거절한다. 원래 경로에 그사이 생긴 node는 덮어쓰지 않는다. 성공한 항목은 휴지통에서 제거된다.

직접 purge는 관리자 API key와 mutation scope·idempotency key를 요구한다. GC는 `expiresAt <= DB now`인 항목을 최대 500개씩 조회해 같은 `purgeTrashItem` 경로로 처리한다. 각 항목은 namespace root 잠금과 DB transaction에서 manifest, quota counter, Blob 참조를 함께 변경한다. 후보 조회 뒤 다른 purge·restore가 먼저 소비한 항목은 재시도 가능한 소진 상태로 다룬다. 참조가 0인 Blob의 object는 기존 orphan GC 유예 기간 이후 정리된다. Purge는 되돌릴 수 없다.

## 회계와 이벤트

논리 quota는 `live FILE bytes + snapshot FILE entry bytes + retained trash FILE bytes`다. 일반 삭제와 복구는 같은 바이트를 live와 trash 사이에 옮긴다. 만료 시각만으로 quota를 해제하지 않고 실제 purge commit에서 해제한다. 보존 node 수는 namespace별 기본 100000이며 `STORIX_MAX_RETAINED_TRASH_NODES`로 양의 안전 정수를 설정한다. 상한을 넘는 새 삭제는 413으로 원자적으로 거절하고 기존 항목을 자동 축출하지 않는다.

삭제는 change feed에 `deleted`, 복구는 `created` net 이벤트를 남긴다. 목록과 purge는 파일 변경 이벤트를 만들지 않는다. Snapshot은 원본 삭제·복구·purge와 독립적으로 유지된다. 조건부 `kind: delete` mutation 및 휴지통 restore·purge의 성공과 결정적 실패 receipt는 namespace·scope·key·요청 fingerprint에 묶여 30일간 재생된다. Legacy `/fs/rm`과 `/fs/rmdir`는 204와 `X-Trash-Id`를 반환하며 mutation receipt를 만들지 않는다. 감사 기록에는 대상 `trash_id`를 남긴다.

로컬 PostgreSQL/MinIO와 SQLite 자동 검증은 코드 경계의 근거다. 운영 DB migration, 실제 백업 복원, 외부 consumer 동작은 별도 검증 대상이다.
