# namespace 생성·관리 receipt는 30일 보존 뒤 GC가 지운다

## 상태

승인됨 (2026-10-02)

## 배경

- `idempotency_key`는 다음 응답을 `Idempotency-Key`별로 저장한다.
  - namespace 생성: 201·이름 충돌 409.
  - 관리 API: quota·trash 정책.
- 정리 경로가 없어 namespace 생성마다 행이 영구히 쌓였다.
- 100만 namespace 데이터셋에서 테이블은 약 840MB, 인덱스는 약 120MB였다.
- VFS mutation receipt(`vfs_mutation_receipt`)는 완료 시점부터 30일 재생한다(api ADR-0024).
  보존 기간이 지나면 GC가 지운다.
- `idempotency_key`에는 namespace FK·요청 종류·만료 시각 컬럼이 없다.

## 결정

- 모든 `idempotency_key` 행을 `created_at`부터 30일 보존한다.
  기간은 VFS mutation receipt와 같다.
- GC의 `idempotency-receipt-prune` 단계가 30일보다 오래된 행을 지운다.
  오래된 순서로 500개씩 처리한다.
  단계 예산은 api ADR-0033을 따른다.
- migration `AddIdempotencyKeyCreatedAtIndex`가 `(created_at, key)` 인덱스를 만든다.
  기존 행은 바꾸지 않는다.
  이미 30일이 지난 행도 GC가 여러 실행에 나눠 지운다.
- 보존 기간이 지나 삭제된 key는 새 요청으로 처리한다.
  - namespace 생성 시 이름이 비어 있으면 새 namespace를 만들고 201을 반환한다.
  - 이름이 있으면 자기 namespace라도 409를 반환한다.
  - 같은 key에 다른 본문을 보내도 422가 아니라 새 요청으로 처리한다.
  - quota·trash 정책 관리 요청도 새 요청으로 적용한다.
- 응답 body에서 namespace 귀속을 추론해 삭제하지 않는다.
  namespace 삭제와 receipt 정리는 별개다.
- 재생과 GC 삭제가 경합하면 처리 시점에 따라 응답한다.
  - 이미 행을 읽은 재생 요청은 그 행으로 응답한다.
  - 삭제 후 요청은 unique key 제약 아래에서 새 요청으로 진행한다.

## 검토한 대안

- **namespace 수명에 연결**:
  - namespace가 ACTIVE인 동안 생성 receipt를 보존한다.
  - `namespace_id` 컬럼과 jsonb 본문 backfill이 필요하다.
  - 409·관리 receipt는 귀속 대상이 없어 별도 정책이 필요하다.
  - 구현 범위가 커 기각했다.
- **영구 보존 유지**:
  - 코드 변경은 없다.
  - namespace 수에 비례해 행이 누적된다.
  - 누적 데이터 보존 정책 요구를 충족하지 못해 기각했다.
- **다른 보존 기간**:
  - 30일은 mutation receipt와 일관된다.
  - 별도 기간을 둘 측정 근거가 없다.

## 결과와 유지 비용

- 30일 보존 후 receipt가 삭제되면 같은 `Idempotency-Key`도 최초 응답을 재생하지 않는다.
- 생성 요청을 30일 넘게 재시도하는 경우는 일반적이지 않다고 판단했다.
- 삭제된 행은 백업 복원 외에 되돌릴 수 없다.
- 보존 기간은 코드 상수 `IDEMPOTENCY_RECEIPT_RETENTION_DAYS`다.
  변경하려면 코드를 고쳐야 한다.
