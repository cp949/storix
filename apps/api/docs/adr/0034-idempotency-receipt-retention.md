# namespace 생성·관리 receipt는 30일 보존 뒤 GC가 지운다

## 상태

승인됨 (2026-10-02)

## 배경

- `idempotency_key` 테이블은 namespace 생성(201·이름 충돌 409)과 관리 API(quota, trash 정책)의 응답을 `Idempotency-Key`별로 저장한다.
- 정리 경로가 없어 namespace를 만들 때마다 행이 영구히 쌓였다. 100만 namespace 데이터셋에서 테이블 약 840MB와 인덱스 약 120MB다.
- VFS mutation receipt(`vfs_mutation_receipt`)는 완료 시점부터 30일 재생하고 GC가 지운다(ADR-0024).
- 이 테이블에는 namespace FK·요청 종류·만료 시각 컬럼이 없다.

## 결정

- 모든 `idempotency_key` 행에 보존 기간 30일을 `created_at` 기준으로 적용한다. VFS mutation receipt와 같은 기간이다.
- GC 단계 `idempotency-receipt-prune`이 `created_at`이 30일보다 오래된 행을 오래된 것부터 500개씩 지운다. 단계 예산(ADR-0033)을 따른다.
- migration `AddIdempotencyKeyCreatedAtIndex`가 `(created_at, key)` 인덱스를 만든다. 기존 행은 바꾸지 않는다. 30일을 넘긴 기존 행은 GC가 여러 실행에 나눠 지운다.
- 기간이 지나 지워진 key의 재요청은 새 요청으로 처리한다.
  - namespace 생성: 이름이 비어 있으면 새 namespace를 만들고 201이다. 이름이 있으면 409다(자기 namespace라도 같다).
  - 같은 key에 다른 본문: 422가 아니라 새 요청이다.
  - 관리 API(quota, trash 정책): 같은 key의 재요청이 새 요청으로 적용된다.
- 응답 body를 보고 namespace에 귀속시켜 지우지 않는다. namespace 삭제와 receipt 정리는 별개다.
- 재생과 GC 삭제가 경합해도 결과는 유지된다. 재생은 읽은 행으로 응답하고, 삭제된 뒤의 요청은 unique key 제약 아래에서 새 요청으로 진행한다.

## 검토한 대안

- **namespace 수명에 연결**: 생성 receipt를 namespace가 ACTIVE인 동안 보존한다. `namespace_id` 컬럼과 jsonb 본문에서의 backfill이 필요하고 409·관리 receipt는 귀속 대상이 없어 별도 정책이 또 필요하다. 구현이 크다. 기각.
- **영구 보존 유지**: 코드 변경이 없지만 namespace 수에 비례해 누적된다. 요구(누적 데이터 보존 정책)를 충족하지 않는다. 기각.
- **다른 보존 기간**: 30일은 mutation receipt와 일관된다. 별도 값을 둘 근거(측정)가 없다.

## 결과와 유지 비용

- 같은 `Idempotency-Key`로 30일 이후 재요청하면 최초 응답이 재생되지 않는다. 호출자가 생성을 30일 넘게 재시도하는 일은 일반적이지 않다.
- 삭제된 행은 백업 복원 외에 되돌릴 수 없다.
- 보존 기간은 코드 상수다(`IDEMPOTENCY_RECEIPT_RETENTION_DAYS`). 바꾸려면 코드 변경이 필요하다.
