# TRP-007 SQLite 재귀 CTE가 namespace 인덱스를 골라 노드 수에 O(N²)가 된다

- 상태: ACTIVE
- 적용 조건: `vfs_node`처럼 큰 테이블을 자기 자신에 조인하는 재귀 CTE(SQLite 경로)를 추가하거나 바꿀 때.

## 오해하기 쉬운 신호

결과 행과 `LIMIT`이 맞고 노드 수천 개의 테스트가 모두 통과한다.
쿼리 문장은 PostgreSQL에서 빠르다.
노드가 6,000개를 넘으면 시간이 N 증가보다 빠르게 늘어난다.
평평한 디렉터리 12,000개를 `removeNode`하면 5.3초 중 5.2초가 이 쿼리였다(GitHub 이슈 #31).

## 원인

- recursive term이 `FROM vfs_node n JOIN tree t ON n.parent_id = t.id WHERE n.namespace_id = ?`였다.
- SQLite 플래너는 `namespace_id` 인덱스를 고르고 `SCAN t`를 했다. `parent_id`는 필터로만 쓰였다.
- 큐 행 하나를 처리할 때마다 namespace의 모든 행을 훑으므로 O(N²)다.
- 통계(`ANALYZE`)가 없어 `t`가 큐 1행이라는 것을 플래너가 모르기 때문으로 추정한다. `ANALYZE` 뒤에는 같은 쿼리가 6ms로 내려갔다.

## 탐지/회피

- 탐지: `EXPLAIN QUERY PLAN`에서 recursive step이 `SCAN t` 뒤에 `SEARCH n USING INDEX <namespace_id 단독 인덱스>`로 나오면 위험하다. `sqlite_autoindex_vfs_node_3 (namespace_id=? AND parent_id=?)`가 나와야 한다.
- 회피: tree에 `namespace_id`를 싣고 `ON n.namespace_id = t.namespace_id AND n.parent_id = t.id`로 조인한다. `captureSnapshotRows`, `copyNode`, `moveNode`가 이 형태다. `find`(`reads.ts`)는 처음부터 이 형태다.
- 회귀 검증: `apps/api/test/persistence/vfs-node.repository.shared-tests/bulk-limits.ts`의 "평평한 디렉터리의 대량 노드 처리 시간"이 12,000개 `removeNode`·`copyNode`를 3.5초 상한으로 확인한다. 수정 전 SQLite에서 rm 5.5초·cp 6.7초로 실패했다.
- 남는 위험:
  - `moveNode`의 CTE는 namespace 조건이 없어 다른 namespace의 행 수에 비례해 느렸다. PostgreSQL 행 211만 개에서 노드 11개 mv가 약 3초였고(`Parallel Seq Scan`), SQLite 행 50만 개에서 CTE만 756ms였다(`SCAN vfs_node`와 `AUTOMATIC COVERING INDEX (parent_id=?)` 생성). `namespace_id` 조건을 더한 뒤 SQLite 같은 조건에서 0ms이고 플랜은 `sqlite_autoindex_vfs_node_3 (namespace_id=? AND parent_id=?)`다. 회귀 검증은 `bulk-limits.ts`의 "mv의 하위 트리 조회 범위"가 재귀 조회의 `JOIN` 조건과 바인드 값을 확인한다. 수정 뒤 PostgreSQL 대용량 재측정은 하지 않았다.
  - PostgreSQL에서 12,000개 `copyNode`는 수정 전 19.2초, 수정 후 22.3초였다. CTE가 아닌 다른 단계의 지연이며 원인은 TRP-008이다.
