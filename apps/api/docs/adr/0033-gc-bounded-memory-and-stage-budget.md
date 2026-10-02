# GC는 storage·DB 후보를 page 단위로 처리하고 단계별 예산과 재개 위치를 둔다

## 상태

승인됨 (2026-10-02)

## 배경

- GC는 `blobs/`·`upload-staging/`의 object와 DB의 `storage_key`·`staging_key` 전체를 대조해 metadata 없는 object를 찾았다(ADR-0006).
- 전체 key 집합과 삭제 대상 목록을 메모리에 모았다. `findOrphanBlobs`도 후보를 한 번에 모두 읽었다.
- namespace가 많은 배포에서 blob 수가 늘면 GC 프로세스 메모리가 blob 수에 비례했다.
- 여러 단계가 후보가 없을 때까지 batch를 끝없이 반복했다. 한 실행의 작업량에 상한이 없었고 재개 위치도 없었다.

## 결정

- `BlobStorage.listPage(prefix, { startAfter, limit })`를 추가한다. key 오름차순으로 한 page만 읽고 이어 읽을 `nextAfter`를 돌려준다. `S3BlobStorage`는 ListObjectsV2의 `StartAfter`·`MaxKeys`를 쓴다(S3 API는 key를 UTF-8 바이트 순서로 돌려준다). `list`는 백업·복원이 계속 쓴다.
- orphan object는 page(1000개)마다 그 page의 key만 DB 인덱스(`blob.storage_key`, `vfs_upload_part.staging_key`, `vfs_upload_staging_cleanup.staging_key`)로 대조하고 바로 삭제한다. 정렬 병합은 쓰지 않는다. backend가 정렬을 보장하지 않을 수 있기 때문이다.
- orphan blob 후보는 `(zero_since, id)` keyset으로 500개씩 읽는다. 삭제에 성공한 object의 행만 지운다. 실패한 행은 한 실행 안에서 다시 읽지 않고 다음 실행에서 후보가 된다.
- 단계마다 한 실행의 예산(`STORIX_GC_MAX_ROWS_PER_STAGE`, 기본 200000)을 둔다. 단위는 단계가 정한 읽은 행 수다.
  - 재개 위치가 필요한 단계(후보가 처리 뒤에도 남을 수 있는 단계)는 예산이 소진되면 위치를 `gc_cursor` 테이블에 저장한다. 다음 실행이 거기서 이어간다. 끝까지 훑으면 위치를 지워 다음 실행이 처음부터 훑는다.
  - 처리한 행이 후보에서 빠지는 단계(lease 복구, receipt prune, session prune, 휴지통 prune)는 위치 없이 예산만 둔다.
  - 예산이 소진된 단계 이름은 GC 결과의 `budgetExhaustedStages`로 알린다.
- 적용 단계와 위치 이름: `change-feed-prune`, `orphan-objects-blobs`, `orphan-objects-staging`, `orphan-blobs`, `expired-upload-sessions`, `staging-reserved-parts`, `staging-cleanup-parts`, `staging-tombstones`, `file-expiry`, `namespace-deletion-advance`, `namespace-deletion-settle`. 위치 없는 단계: `stale-finalizing-lease-recovery`, `mutation-receipt-prune`, `upload-session-prune`, `trash-prune`.
- grace period·`zero_since`·참조 0 규칙, 삭제 성공분만 행 삭제, staging의 미삭제 part와 cleanup tombstone 보호는 바뀌지 않는다. 저장소 I/O 동안 긴 DB 트랜잭션을 잡지 않는다.

## 검토한 대안

- **전체 key 집합을 유지하고 삭제 대상만 page로 처리**: 집합 크기가 blob 수에 비례한다. 기각.
- **DB key를 정렬해 storage 목록과 병합**: storage 목록의 정렬을 backend마다 보장하기 어렵다. 기각.
- **시간 예산**: 결과가 실행 환경에 따라 달라지고 테스트가 비결정적이다. 행 수 예산을 쓴다.
- **재개 위치 없이 매 실행 처음부터 시작**: 실패하는 후보가 앞쪽에 계속 남으면 뒤쪽 후보가 기아 상태가 된다. 기각.
- **변경 이력 feed 후보를 state 행에 기록(선두 이벤트 시각)**: 이벤트 기록 경로에 불변식과 migration이 필요하다. 만료 이벤트 인덱스를 cursor로 훑는 방식으로 같은 상한을 얻는다.

## 결과와 유지 비용

- GC 프로세스의 보유 메모리는 page 크기에 비례하고 blob·object 수에 비례하지 않는다. 100만 namespace·object 약 51.5만 개 데이터셋에서 이전 구현은 Node heap 상한 96MB에서 종료했고(128MB에서 통과) 새 구현은 48MB에서 통과했다. 같은 환경에서 10,000 namespace도 48MB에서 통과하고 40MB에서 종료한다. 40MB 아래는 Node와 Nest 기동 자체의 하한이다.
- 새 migration `AddGcCursor1791700000012`(테이블 `gc_cursor`)가 필요하다. down은 재개 위치만 잃는다.
- 전체 bucket을 훑는 비용은 object 수에 비례한다. 한 실행은 예산만큼만 훑고 여러 실행에 나눠 끝낸다. 예산 기본값은 측정 근거 없이 정한 값이다.
- 위치보다 앞에서 뒤늦게 후보가 된 행은 위치가 끝에 닿아 지워진 다음 실행에서 처리된다. 정리 지연이 늘 수 있다.
- namespace 삭제 operation은 page(100개) 단위로 예산에 센다. 한 operation의 metadata 제거는 끝까지 진행한다(docs/design/13-namespace-deletion.md).
- `STORIX_GC_MAX_ROWS_PER_STAGE`를 너무 작게 잡으면 정리가 여러 실행으로 늘어진다.
