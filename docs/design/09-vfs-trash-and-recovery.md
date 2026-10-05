# VFS 휴지통과 삭제 복구

## Namespace 정책

아래 파일 삭제·복구·receipt 계약은 ACTIVE namespace에 적용한다. namespace 전체 삭제는 [namespace 삭제 설계](./13-namespace-deletion.md)의 "접근과 이름 재사용"·"METADATA"를 따른다.

- 휴지통은 namespace별 `trashEnabled` 정책이며 기본값은 OFF다.
- 관리자 PATCH로 변경하고 namespace 조회 응답의 `quota.trash.enabled`에서 현재 값을 확인한다.
- 정책 변경과 삭제는 같은 namespace root mutation lock 및 DB transaction을 사용한다.
- 동시 변경·삭제는 lock 획득 순서에 따라 적용 정책이 결정된다.

- 정책 ON에서는 삭제를 manifest로 보존한다.
- OFF에서는 `/fs/rm`, `/fs/rmdir`, 조건부 `kind: delete`가 manifest 없이 원자적으로 영구 삭제한다.
- 이때 live byte와 live Blob 참조를 감소시키고 `deleted` change-feed net event를 기록한다.
- 다른 live·snapshot 참조는 그대로 유지한다.
- OFF 삭제의 조건부 receipt는 정책이 나중에 바뀌어도 최초 응답을 재생하며, 즉시 삭제에는 `trashId`, `X-Trash-Id`, 감사 `trash_id`가 없다.

OFF 전환은 이미 만들어진 trash item을 제거하거나 숨기지 않는다. 항목은 기존 만료·목록·복원·purge 규칙을 따르며, 복원은 live/trash quota와 Blob 참조를 기존 규칙대로 이동한다.

## 상태와 수명

- 현재 live node의 `revision`은 조건부 변경을 위한 불투명 비교 토큰이며 과거 본문 이력이 아니다.
- 과거 바이트를 독립적으로 보존하려면 FILE 또는 TREE snapshot을 명시적으로 만든다.
- 휴지통 정책 ON의 삭제는 한 파일 또는 한 디렉터리 subtree를 휴지통 manifest 한 건으로 옮긴다.
- Manifest는 원래 node ID·revision·상대 경로·유형·파일 metadata·Blob 참조와 원래 root 경로를 가진다.
- 삭제된 live 경로는 즉시 비워지므로 같은 경로에 새 node를 만들 수 있다.

- 각 항목의 `deletedAt`은 DB 시각이며 `expiresAt`은 30일 뒤다.
- `GET /fs/trash`는 미만료 항목만 `deletedAt DESC, trashId ASC` keyset cursor로 열거한다.
- 만료 뒤 복구는 GC 전에도 410이다.
- 없는 ID나 다른 namespace ID는 404다.
- 만료 시각은 검사 시점의 DB 시각과 비교한다.

## 복구와 영구 삭제

- 복구는 원래 경로 또는 명시한 `targetPath`에 manifest 전체를 되살린다.
- 원래 node ID와 subtree 구조를 유지하고 모든 node에 새 revision을 발급한다.
- 복구 경로의 부모가 없거나 대상이 이미 있으면 전체 변경을 거절한다.
- 원래 경로에 그사이 생긴 node는 덮어쓰지 않는다.
- 성공한 항목은 휴지통에서 제거된다.

- 직접 purge는 관리자 API key와 mutation scope·idempotency key를 요구한다.
- GC는 `expiresAt <= DB now`인 항목을 최대 500개씩 조회해 같은 `purgeTrashItem` 경로로 처리한다.
- 각 항목은 namespace root 잠금과 DB transaction에서 manifest, quota counter, Blob 참조를 함께 변경한다.
- 후보 조회 뒤 다른 purge·restore가 먼저 소비한 항목은 재시도 가능한 소진 상태로 다룬다.
- 그 밖의 예상 밖 오류(ACTIVE namespace root 손상, manifest·counter 불일치 등)는 항목별로 격리한다.
  - 해당 항목은 남기고 `error` 로그(namespace·trash ID·원인)를 남긴 뒤 다음 항목을 처리한다.
  - GC 결과의 `failedTrashItems`에 실패 항목 수를 집계한다. GC는 실패로 끝나지 않는다.
  - 실패 항목은 만료 순서상 맨 앞이라 다음 실행에서 다시 시도한다.
- 참조가 0인 Blob의 object는 기존 orphan GC 유예 기간 이후 정리된다.
- Purge는 되돌릴 수 없다.

## 회계와 이벤트

- `quota.usedBytes`는 `live FILE bytes + snapshot FILE entry bytes + retained trash FILE bytes`다.
- quota 검사 대상은 구성요소 제외 정책을 반영한 `quota.enforcedBytes`다.
- 계산 규칙은 [Namespace 제한과 설정](./14-namespace-limits-and-counters.md)의 "Quota 구성요소"를 따른다.
- 휴지통 정책 ON의 삭제와 복구는 같은 바이트를 live와 trash 사이에 옮긴다.
- 만료 시각만으로 retained 사용량을 해제하지 않고 실제 purge commit에서 해제한다.
- 보존 node 수는 namespace별 기본 100000이며 `STORIX_MAX_RETAINED_TRASH_NODES`로 양의 안전 정수를 설정한다.
- 상한을 넘는 새 삭제는 413으로 원자적으로 거절하고 기존 항목을 자동 축출하지 않는다.

- 삭제는 change feed에 `deleted`, 복구는 `created` net 이벤트를 남긴다.
- 목록과 purge는 파일 변경 이벤트를 만들지 않는다.
- Snapshot은 원본 삭제·복구·purge와 독립적으로 유지된다.
- 조건부 `kind: delete` mutation 및 휴지통 restore·purge의 성공과 결정적 실패 receipt는 namespace·scope·key·요청 fingerprint에 묶여 30일간 재생된다.
- Legacy `/fs/rm`과 `/fs/rmdir`는 204와 `X-Trash-Id`를 반환하며 mutation receipt를 만들지 않는다.
- 감사 기록에는 대상 `trash_id`를 남긴다.

로컬 PostgreSQL과 SQLite 자동 검증은 코드 경계의 근거다. 운영 DB migration, 실제 백업 복원, 외부 consumer 동작은 별도 검증 대상이다.

휴지통 quota 제외 여부와 retained byte cap은 [Namespace 제한과 설정](./14-namespace-limits-and-counters.md)의 "Quota 구성요소"·"설정 API"를 따른다.
