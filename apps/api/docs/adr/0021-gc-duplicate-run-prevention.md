# GC는 Postgres advisory lock과 최소 재실행 간격으로 멀티 인스턴스 중복 실행을 스스로 막는다

ADR-0003의 NAS 기반 멀티 인스턴스 토폴로지(WAS마다 VersityGW 1:1, Postgres 공유)에서는
모든 WAS 호스트가 같은 compose 파일을 갖는다. `gc`는 `blobs/` 전체와 공유 DB의
전체 storage_key 집합을 대상으로 동작하므로(ADR-0006), 호스트마다 독립적으로
트리거하면(각자의 cron 등) 실제로는 함대 전체 데이터를 대상으로 하는 스캔·삭제가
중복 실행된다. `docs/deployment/multi-instance-versitygw.md`가 이미 "함대당 한
곳에서만 실행"이라는 운영 규칙을 두고 있었지만, 이는 사람이 지켜야 하는 절차일
뿐이라 모든 호스트에 동일한 트리거가 배포되면 쉽게 깨진다.

`pg_try_advisory_lock`만으로는 동시 실행은 막아도 중복 실행 자체는 막지 못한다 —
락은 비차단(non-blocking)이라 A가 실행을 마치고 반납하면 곧바로 B가 획득해 처음부터
다시 돈다. 즉 mutex(동시에 하나만)와 dedup(총 실행 횟수를 줄임)은 다른 문제다.
그래서 락에 "최근 완료 시각" 기반 쿨다운을 더했다: `gc_state`(단일 행) 테이블에
`last_completed_at`을 기록하고, 락을 얻은 뒤에도 이 값이 `STORIX_GC_MIN_INTERVAL`
(기본 3600초) 이내면 실행하지 않고 락을 반납한다. 이렇게 하면 몇 대가 언제
트리거하든 그 간격 안에서는 실제 스캔·삭제가 한 번만 일어난다.

`GcLock`(`src/jobs/gc-lock.ts`)이 이 절차를 담당한다: advisory lock 획득 →
쿨다운 확인(락 유지, 실패 시 unlock 후 반납) → (`gc-main.ts`가) `GcJob.run()`
실행 → `markCompleted()`로 `last_completed_at` 갱신 → `release()`로 unlock. 락은
세션(커넥션) 단위라 프로세스가 크래시해도 커넥션이 끊기면 Postgres가 자동으로
해제한다 — TTL이나 하트비트 관리가 필요 없다. `DataSource.query()`(커넥션을 매번
새로 빌림)로는 세션 단위 락을 관리할 수 없어, `DataSource.createQueryRunner()`로
커넥션 하나를 명시적으로 붙잡아 락→쿨다운 확인→(작업)→unlock을 같은 커넥션에서
처리한다.

이 락은 GC의 삭제가 이미 멱등하게 설계돼 있다는 전제(ADR-0006 — 이미 지운
key/row를 다시 지워도 에러 없음) 위에 있다. 즉 중복 실행이 데이터를 깨뜨리는
correctness 문제가 아니라 순전히 낭비되는 스캔·I/O 문제였기 때문에, 정확성
보장이 아니라 효율을 위한 장치다.

`backup`/`restore`는 이 메커니즘을 적용하지 않는다. `backup`은 중복 실행돼도
데이터 손상이 없어(단순 I/O 낭비) 급하지 않고, `restore`의 위험은 "동시
실행"이 아니라 "함대 전체가 정지된 상태여야 함"이라 락 하나로 해결되는 문제가
아니다. 둘 다 여전히 `docs/deployment/multi-instance-versitygw.md`의 운영
규칙(함대당 한 곳에서만, 사람이 지킴)에 의존한다.

## Considered Options

- **compose 구조를 바꿔 `gc`를 WAS별 base 스택에서 아예 분리**(함대에 하나뿐인
  별도 compose 파일/전용 호스트로 이동): 트리거 자체를 물리적으로 하나로
  만들어 중복 실행 가능성을 원천 차단한다. 하지만 ADR-0004의 compose 파일
  배치를 다시 설계해야 하고, 기존 단일 인스턴스 배치와의 호환성도 다시
  검토해야 해서 범위가 커진다. 지금 필요한 건 "여러 트리거가 있어도
  안전"이지 "트리거를 하나로 줄이기"가 아니라고 판단해 채택하지 않았다.
- **외부 좌표 서비스(etcd/Consul/Redis 리더 선출)**: 이미 공유하는 Postgres로
  충분한데 새 인프라 의존성을 추가하는 셈이라 채택하지 않았다.
- **TTL 기반 수동 lock row(하트비트로 갱신)**: Postgres advisory lock이 세션
  종료 시 자동 해제되는 것과 대조적으로, TTL 방식은 하트비트 갱신 로직과 만료
  판정을 직접 구현·유지보수해야 한다. advisory lock이 이미 크래시 안전성을
  공짜로 제공하므로 채택하지 않았다.
