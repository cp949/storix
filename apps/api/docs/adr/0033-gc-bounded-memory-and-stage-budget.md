# GC는 storage·DB 후보를 page 단위로 처리하고 단계별 예산과 재개 위치를 둔다

## 상태

승인됨 (2026-10-02)

## 배경

- 이전 GC는 storage와 DB의 전체 key를 대조해 metadata 없는 object를 찾았다(api ADR-0006).
  - storage: `blobs/`·`upload-staging/`의 object.
  - DB: `storage_key`·`staging_key`.
- 전체 key 집합과 삭제 대상 목록을 메모리에 모았다.
- `findOrphanBlobs`도 후보를 한 번에 모두 읽었다.
- blob 수가 늘면 GC 메모리가 blob 수에 비례해 증가했다.
- 여러 단계는 후보가 없을 때까지 batch를 반복했다.
- 한 실행의 작업량 상한과 재개 위치가 없었다.

## 결정

- `BlobStorage.listPage(prefix, { startAfter, limit })`를 추가한다.
  - key 오름차순으로 한 page를 읽는다.
  - 이어 읽을 위치는 `nextAfter`로 반환한다.
  - `S3BlobStorage`는 ListObjectsV2의 `StartAfter`·`MaxKeys`를 쓴다.
  - S3 API는 key를 UTF-8 바이트 순서로 반환한다.
  - 백업·복원은 기존 `list`를 계속 쓴다.
- orphan object는 1000개씩 읽는다.
  - 해당 page의 key만 다음 DB 인덱스로 대조한다.
    - `blob.storage_key`.
    - `vfs_upload_part.staging_key`.
    - `vfs_upload_staging_cleanup.staging_key`.
  - 대조 후 orphan object를 바로 삭제한다.
  - backend가 정렬을 보장하지 않을 수 있어 정렬 병합은 쓰지 않는다.
- orphan blob 후보는 `(zero_since, id)` keyset으로 500개씩 읽는다.
  - object 삭제에 성공한 행만 지운다.
  - 실패한 행은 같은 실행에서 다시 읽지 않는다.
  - 다음 실행에서 다시 후보가 된다.
- 단계마다 `STORIX_GC_MAX_ROWS_PER_STAGE`로 한 실행의 예산을 둔다.
  - 기본값은 200000이다.
  - 단위는 각 단계가 정한 읽은 행 수다.
  - 처리 후에도 후보가 남을 수 있는 단계는 재개 위치를 쓴다.
  - 예산이 소진되면 위치를 `gc_cursor`에 저장한다.
  - 다음 실행은 저장한 위치에서 이어간다.
  - 끝까지 훑으면 위치를 지운다.
  - 그다음 실행은 처음부터 시작한다.
  - 처리 후 후보가 사라지는 단계는 위치 없이 예산만 둔다.
  - 예산 소진 단계는 GC 결과의 `budgetExhaustedStages`로 알린다.
- 재개 위치를 두는 단계:
  - `change-feed-prune`.
  - `orphan-objects-blobs`.
  - `orphan-objects-staging`.
  - `orphan-blobs`.
  - `expired-upload-sessions`.
  - `staging-reserved-parts`.
  - `staging-cleanup-parts`.
  - `staging-tombstones`.
  - `file-expiry`.
  - `namespace-deletion-advance`.
  - `namespace-deletion-settle`.
- 위치 없이 예산만 두는 단계:
  - `stale-finalizing-lease-recovery`.
  - `mutation-receipt-prune`.
  - `upload-session-prune`.
  - `trash-prune`.
- 기존 정리 규칙은 유지한다.
  - grace period·`zero_since`·참조 0 조건을 유지한다.
  - object 삭제에 성공한 행만 삭제한다.
  - 미삭제 staging part와 cleanup tombstone을 보호한다.
  - 저장소 I/O 동안 긴 DB 트랜잭션을 유지하지 않는다.

## 검토한 대안

- **전체 key 집합을 유지하고 삭제 대상만 page로 처리**:
  - 집합 크기가 blob 수에 비례해 기각했다.
- **DB key를 정렬해 storage 목록과 병합**:
  - backend마다 storage 목록의 정렬을 보장하기 어려워 기각했다.
- **시간 예산**:
  - 결과가 실행 환경에 따라 달라진다.
  - 테스트 결과를 일정하게 유지하기 어려워 행 수 예산을 쓴다.
- **재개 위치 없이 매번 처음부터 시작**:
  - 실패하는 후보가 앞에 남으면 뒤쪽 후보가 처리되지 않을 수 있어 기각했다.
- **변경 이력 feed의 선두 이벤트 시각을 state 행에 기록**:
  - 이벤트 기록 경로에 불변식과 migration이 필요하다.
  - 만료 이벤트 인덱스를 cursor로 훑어도 같은 작업량 상한을 얻는다.

## 결과와 유지 비용

- GC가 보유하는 메모리는 page 크기에 비례한다.
  blob·object 수에는 비례하지 않는다.
  Node heap 상한을 바꿔 실측한 결과:
  - 100만 namespace·약 51.5만 object에서 이전 구현은 96MB로 종료했고 128MB로 통과했다.
  - 같은 데이터셋에서 새 구현은 48MB로 통과했다.
  - 같은 환경의 10,000 namespace도 48MB로 통과했고 40MB로 종료했다.
  - 40MB 아래는 Node와 Nest 기동 자체의 하한이다.
- migration `AddGcCursor1791700000012`가 `gc_cursor`를 만든다.
  down은 재개 위치만 제거한다.
- 전체 bucket을 훑는 비용은 object 수에 비례한다.
  한 실행은 예산만큼 훑는다.
  여러 실행에 나눠 전체를 처리한다.
  예산 기본값은 측정 근거 없이 정한 값이다.
- 재개 위치 앞에서 뒤늦게 후보가 된 행은 위치를 지운 다음 실행에서 처리한다.
  정리 지연이 늘 수 있다.
- namespace 삭제 operation은 100개 page 단위로 예산에 센다.
  한 operation의 metadata 제거는 끝까지 진행한다.
  세부 규칙은 `docs/design/13-namespace-deletion.md`에 둔다.
- `STORIX_GC_MAX_ROWS_PER_STAGE`가 너무 작으면 정리에 필요한 실행 횟수가 늘어난다.
