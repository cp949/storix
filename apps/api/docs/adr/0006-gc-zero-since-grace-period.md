# GC는 zero_since 기반 grace period와 object-먼저-metadata-나중 순서로 orphan Blob을 회수한다

## grace period 기준

- `blob.zero_since`는 nullable timestamptz 컬럼이다.
- `reference_count`를 0으로 만드는 UPDATE에서 `zero_since = now()`를 함께 기록한다.
- `reference_count`는 0이 된 뒤 다시 증가하지 않는다.
  - 독립 업로드는 dedup하지 않는다.
  - `cp`의 source는 Blob을 참조 중인 Node를 통해서만 선택한다.
- `zero_since`는 한 번만 기록한다.
- `zero_since`를 리셋하는 로직은 두지 않는다.

`zero_since`는 참조가 0이 된 시점부터 grace period를 계산하기 위한 기준이다.
이 ADR의 `ORPHAN_GRACE_PERIOD`에 해당하는 현재 설정명은 `STORIX_ORPHAN_GRACE_PERIOD`다.

## 회수 순서

GC job은 다음 조건을 모두 만족하는 Blob을 고른다.

- `reference_count = 0`
- `zero_since` 이후 `ORPHAN_GRACE_PERIOD`초 경과

회수 절차:

1. 스토리지 object를 삭제한다.
2. object 삭제에 성공한 Blob의 metadata row만 삭제한다.

이 순서를 택한 근거:

- 스토리지 object 삭제는 대상이 없어도 성공한다(S3 DELETE 표준).
- object 삭제 후 metadata 삭제 전에 프로세스가 종료되면 다음 실행이 같은 row를 다시 선택한다.
- 같은 object를 다시 삭제해도 성공하므로 회수를 재시도할 수 있다.

metadata 없는 object도 같은 grace period로 회수한다.

- 대상은 실패하거나 충돌한 업로드의 잔여 object다.
- storage가 반환한 `lastModified`로 object의 경과 시간을 판단한다.
- DB에 존재하는 `storage_key`와 대조해 orphan을 찾는다.
- 대조는 storage page 단위로 한다(api ADR-0033).

## DB lock과 실행 방식

- 후보는 lock 없이 조회한다.
- DB 삭제는 스토리지 삭제 후 짧은 트랜잭션으로 일괄 처리한다.
- 스토리지 I/O 동안 Postgres row lock을 유지하지 않는다.

GC는 HTTP 서버와 분리한 단발성 프로세스로 실행한다.

- `gc-main.ts`에서 `GcAppModule`을 `NestFactory.createApplicationContext`로 부트스트랩한다.
- `docker-compose.yml`의 `profiles: ['gc']`로 묶는다.
- 기본 `docker compose up` 실행에는 포함하지 않는다.
- 배포 주기나 스케줄러(cron 등)에서 독립적으로 실행·재시도한다.

파괴적 삭제 작업을 상시 요청 처리 경로와 분리하기 위한 결정이다.

## grace period의 한계

- lock 없는 후보 스냅샷 조회의 안전 여유는 `ORPHAN_GRACE_PERIOD`에 의존한다.
- metadata가 아직 커밋되지 않은 업로드 object는 grace period가 지나지 않았다는 조건으로 보호한다.
- grace period가 업로드 소요 시간보다 짧으면 진행 중인 object를 orphan으로 오인해 삭제할 수 있다.

## Considered Options

- **`updated_at` 컬럼 재사용**
  - `BlobEntity`에 범용 `@UpdateDateColumn`을 추가해 grace period 기준으로 쓰는 안이다.
  - 다른 Blob 필드 갱신까지 기준 시점을 바꿀 수 있다.
  - 전용 `zero_since` 컬럼으로 참조가 0이 된 시점만 기록한다.
- **스토리지 삭제와 metadata 삭제를 하나의 분산 트랜잭션으로 처리**
  - Postgres와 스토리지는 같은 트랜잭션 매니저를 공유하지 않는다.
  - 하나의 트랜잭션으로 처리하려면 2PC가 필요하다.
  - object를 먼저 삭제하고 멱등하게 재시도해 최종 일관성을 확보한다.
