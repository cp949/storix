# GC는 Postgres advisory lock과 최소 재실행 간격으로 멀티 인스턴스 중복 실행을 스스로 막는다

ADR-0003의 NAS 기반 멀티 인스턴스 토폴로지는 WAS마다 VersityGW를 1:1로 두고 Postgres를 공유한다.
모든 WAS 호스트는 같은 compose 파일을 갖는다.
`gc`는 `blobs/` 전체와 공유 DB의 전체 storage_key 집합을 대상으로 동작한다(api ADR-0006).
호스트마다 cron 등으로 트리거하면 함대 전체의 스캔·삭제가 중복 실행된다.

`docs/deployment/multi-instance-versitygw.md`는 GC를 함대당 한 곳에서만 실행하도록 정했다.
이 운영 절차만으로는 모든 호스트에 동일한 트리거가 배포되는 경우를 막지 못한다.

`pg_try_advisory_lock`은 동시 실행만 막는다.
A가 락을 반납하면 B가 곧바로 획득해 처음부터 다시 실행할 수 있다.
mutex는 동시 실행을 제한한다.
dedup은 총 실행 횟수를 줄인다.

GC는 락과 함께 최근 완료 시각 기반 쿨다운을 쓴다.
`gc_state` 단일 행의 `last_completed_at`에 완료 시각을 기록한다.
락 획득 후 경과 시간이 `STORIX_GC_MIN_INTERVAL`(기본 3600초)보다 짧으면 실행하지 않고 락을 반납한다.
여러 호스트가 트리거해도 완료 후 이 간격 안에서는 스캔·삭제를 다시 실행하지 않는다.

`GcLock`(`src/jobs/gc-lock.ts`)과 `gc-main.ts`의 처리 순서:

1. `GcLock`이 advisory lock을 획득한다.
2. 락을 유지한 채 쿨다운을 확인한다.
   - 실행 간격을 충족하지 않으면 unlock 후 커넥션을 반납한다.
3. `gc-main.ts`가 `GcJob.run()`을 실행한다.
4. `markCompleted()`가 `last_completed_at`을 갱신한다.
5. `release()`가 unlock 후 커넥션을 반납한다.

락은 세션(커넥션) 단위다.
프로세스가 중단돼 커넥션이 끊기면 Postgres가 자동 해제한다.
TTL이나 하트비트 관리는 필요 없다.
`DataSource.query()`는 호출마다 커넥션을 빌려 세션 단위 락을 관리할 수 없다.
`DataSource.createQueryRunner()`로 커넥션 하나를 유지한다.
락 획득·쿨다운 확인·unlock은 같은 커넥션에서 처리한다.

lock 커넥션은 GC 실행 동안 idle이다.
`idle_session_timeout`이나 failover로 서버가 이 커넥션을 끊으면 락이 풀린다.

- 실행 중 다른 인스턴스가 락을 얻어 동시에 실행할 수 있다. 아래 멱등성 때문에 정확성 영향은 없다.
- 완료 시각은 lock 커넥션이 아닌 별도 커넥션(`DataSource.query()`)으로 기록한다. 그래서 끊겨도 쿨다운이 유지된다.
- `markCompleted()`는 기록 전에 lock 커넥션에 `SELECT 1`을 보낸다. 실패하면 동시 실행 가능성을 경고로 남긴다.
- `release()`는 끊긴 커넥션의 unlock·반납 실패를 경고로만 남긴다. 서버가 세션과 함께 락을 이미 풀었기 때문이다.

GC 삭제는 이미 멱등하게 설계돼 있다(api ADR-0006).
이미 지운 key나 row를 다시 지워도 오류가 없다.
이 락은 데이터 정확성보다 중복 스캔·I/O를 줄이기 위한 장치다.

`backup`과 `restore`에는 이 메커니즘을 적용하지 않는다.

- `backup`의 중복 실행은 데이터를 손상시키지 않고 I/O만 낭비한다.
- `restore`는 함대 전체가 정지된 상태여야 한다. 락 하나로 이 조건을 보장할 수 없다.

두 작업은 여전히 `docs/deployment/multi-instance-versitygw.md`의 운영 규칙에 의존한다.
운영자가 함대당 한 곳에서만 실행해야 한다.

## Considered Options

- **compose에서 `gc`를 WAS별 base 스택과 분리**:
  - 함대 전용 compose 파일이나 호스트에 트리거를 하나만 둔다.
  - 중복 실행 가능성을 트리거 배치에서 차단한다.
  - ADR-0004의 compose 파일 배치를 다시 설계해야 한다.
  - 기존 단일 인스턴스 배치와의 호환성도 검토해야 한다.
  - 여러 트리거의 중복 실행을 막는 데 필요한 범위를 넘어 채택하지 않았다.
- **외부 조정 서비스(etcd/Consul/Redis 리더 선출)**:
  - 공유 Postgres로 처리할 수 있다.
  - 새 인프라 의존성이 필요해 채택하지 않았다.
- **TTL 기반 수동 lock row**:
  - 하트비트 갱신과 만료 판정을 직접 구현·유지보수해야 한다.
  - advisory lock은 세션 종료 시 자동 해제된다.
  - 별도 TTL 관리가 필요 없어 채택하지 않았다.
