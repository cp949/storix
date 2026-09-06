# GC는 zero_since 기반 grace period와 object-먼저-metadata-나중 순서로 orphan Blob을 회수한다

Blob의 reference_count가 0이 된 시점을 추적하지 않으면 grace period를 계산할
기준점이 없다. `blob` 테이블에 `zero_since`(nullable timestamptz) 컬럼을 추가해,
reference_count를 감소시키는 UPDATE가 0을 만드는 순간 같은 문장에서
`zero_since = now()`를 채운다. reference_count는 한 번 0이 되면 다시 증가하지
않으므로(독립 업로드는 dedup하지 않고, `cp`의 source는 항상 참조 중인 Node를 거쳐야
하므로) 이 값은 리셋 로직 없이 단조적으로 한 번만 채워진다.

GC job은 `reference_count=0`이고 `zero_since`가 grace period(`ORPHAN_GRACE_PERIOD`
초)보다 오래된 Blob을 찾아 (1) MinIO object 삭제 (2) 성공한 것만 모아 metadata row
삭제 순서로 처리한다. MinIO object 삭제는 대상이 이미 없어도 에러 없이 성공하므로
(S3 DELETE 표준), 이 순서는 crash 후 재시작해도 안전하게 재시도된다: object만
지워지고 metadata 삭제 전에 죽어도 다음 실행이 같은 row를 다시 골라 멱등하게
끝낸다. metadata 없는 MinIO object(실패·충돌한 업로드의 잔여물)도 같은 grace
period를 적용해 회수한다 — `list()`가 반환하는 object의 lastModified와 DB에 존재하는
전체 storage_key 집합을 대조해 찾아낸다.

Postgres row lock을 MinIO I/O(네트워크 호출) 동안 붙들지 않기 위해, 후보 조회는 lock
없이 수행하고 DB 삭제는 MinIO 삭제가 끝난 뒤 짧은 트랜잭션으로 일괄 수행한다.

GC는 HTTP 서버와 같은 프로세스에서 돌리지 않는다. `gc-main.ts`의 얇은
`GcAppModule`을 `NestFactory.createApplicationContext`로 부트스트랩하는 별도
단발성 프로세스로 두고, `docker-compose.yml`에 `profiles: ['gc']`로 묶어
`docker compose up` 기본 실행에는 포함되지 않게 했다. 파괴적 삭제 작업을 상시
기동되는 요청 처리 경로와 분리해, 배포 주기나 스케줄러(cron 등)에서 독립적으로
실행·재시도할 수 있게 하기 위함이다.

`ORPHAN_GRACE_PERIOD`를 지나치게 짧게 잡으면 이 lock-free candidate 스냅샷
방식의 안전 여유가 줄어든다는 점에 유의한다: object-먼저 스캔은 아직 metadata
row가 커밋되지 않은 업로드 중인 object를 grace period보다 어리다는 이유로
살려두는 것에 의존하므로, grace period가 업로드 소요 시간보다 짧아지면 진행
중인 업로드가 orphan으로 오인되어 삭제될 위험이 생긴다.

## Considered Options

- **`updated_at` 컬럼 재사용**: `BlobEntity`에 범용 `@UpdateDateColumn`을 추가하고 이를
  grace period 기준점으로 쓰는 방법도 있었으나, 향후 Blob에 reference_count 외의
  필드를 갱신하는 기능이 추가되면 의미가 오염된다. `zero_since` 전용 컬럼이 의도를
  명확히 하고 결합도를 낮춘다.
- **MinIO 삭제와 metadata 삭제를 하나의 분산 트랜잭션으로 묶기**: Postgres와 MinIO는
  같은 트랜잭션 매니저를 공유하지 않아 2PC 없이는 불가능하다. 대신 "object 먼저,
  metadata 나중" 순서와 멱등한 재시도로 최종 일관성을 확보하는 쪽을 택했다.
