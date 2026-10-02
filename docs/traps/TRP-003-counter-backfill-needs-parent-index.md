# TRP-003 Counter backfill correlated query can become quadratic

- 상태: ACTIVE
- 적용 조건: 기존 tree row에서 부모별 counter를 backfill하는 migration을 작성할 때

## 오해하기 쉬운 신호

작은 fixture migration은 통과하고 빠르게 끝나도, 큰 namespace에서 같은 시간 복잡도를 보장하지 않는다.

## 원인

부모 row마다 자식 `COUNT(*)`를 실행하는 correlated update는 parent ID로 검색할 수 있는 인덱스가 없으면 매번 전체 child table을 읽는다. `(namespace_id, parent_id, name)` 인덱스는 `parent_id`만 조회하는 전체 backfill에 적합하지 않다.

## 탐지/회피

- 대상 데이터 규모의 PostgreSQL에서 `EXPLAIN`으로 child lookup이 전체 scan인지 확인한다.
- grouped aggregate update를 쓰거나 `(parent_id, type)` 인덱스를 backfill 전에 만든다.
- 임시 인덱스는 backfill 뒤 제거한다.
- 10만·100만 실제 행에서 migration 시간과 잠금 영향을 측정한다.
