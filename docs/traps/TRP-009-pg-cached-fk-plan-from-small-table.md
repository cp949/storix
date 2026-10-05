# TRP-009 PostgreSQL이 작은 테이블에서 만든 FK 트리거 계획을 테이블이 커진 뒤에도 쓴다

- 상태: ACTIVE
- 적용 조건: 비어 있거나 작은 `vfs_node`에 FK 트리거가 걸린 대량 INSERT(`copyNode` 등)를 PostgreSQL에서 시간 단언하거나 측정할 때. 새 DB·새 테스트 컨테이너가 해당한다.

## 오해하기 쉬운 신호

쿼리 수와 결과가 맞고 쿼리 수 단언이 통과한다.
같은 쿼리를 `EXPLAIN`으로 따로 실행하면 `UQ_vfs_node_id_namespace_id`를 써서 0.03ms다.
그런데 평평한 12,000개 `copyNode`는 PG에서 6.6초가 걸린다(GitHub 이슈 #35).
실행마다 시간이 흔들리고, 앞선 측정에서는 18~38초 범위였다.

## 원인

- FK 트리거(`FK_vfs_node_parent`)의 RI 쿼리 계획은 backend 세션에 캐시된다.
- 테이블이 2행일 때 만든 계획은 `IDX_vfs_node_namespace_id_blob_id`를 쓰고 `id`를 Filter로 거른다.
- 이 계획은 테이블이 12,002행으로 커진 뒤에도 같은 세션에서 유지됐다. 조회 1회가 `Rows Removed by Filter: 12001`, 0.69ms였다.
- `ANALYZE vfs_node`가 계획을 무효화하면 `UQ_vfs_node_id_namespace_id`로 다시 만들어져 0.028ms가 됐다.
- PG 통합테스트 `flat-cp`는 `ANALYZE` 없이 6,601ms, cp 직전에 `ANALYZE` 하면 1,080~1,167ms였다.
- 인덱스를 바꿔도 해결되지 않았다. `IDX_..._blob_id`를 `WHERE blob_id IS NOT NULL` 부분 인덱스로 바꾸거나 지워도 `UQ_vfs_node_child_name`(`namespace_id` 선두)을 골라 같은 Filter가 생겼다.
- `(namespace_id, id)` 인덱스를 추가하면 해소됐지만 노드 쓰기마다 인덱스 1개가 늘어난다. 채택하지 않았다.
- 계획이 작은 테이블에서 같은 비용으로 갈리는 이유는 플래너 소스로 확인하지 못했다. 위 수치는 관찰 결과다.

## 운영 영향

- 새 테이블 크기가 곧 계획에 반영되므로, 새로 연 세션은 큰 테이블에서 올바른 계획을 만든다. N=12,000·100,000·1,000,000, 통계 없음·`ANALYZE` 후·오래된 통계 조합에서 `findOneBy`와 RI 쿼리는 모두 `UQ_vfs_node_id_namespace_id`였다(0.02~0.09ms).
- 오래된 계획이 남는 구간은 테이블이 작을 때 세션이 RI 쿼리를 처음 실행한 뒤 첫 `ANALYZE`(autoanalyze 포함)까지다. 이 구간의 길이는 측정하지 않았다.
- 기본 `STORIX_MAX_SYNC_COPY_NODES`가 1,000이라 한 cp 트랜잭션의 영향도 이 안에서 끝난다. 테스트처럼 상한을 올리면 커진다.
- 운영 권고는 `docs/deployment/postgres-plan-cache.md`다.

## 탐지/회피

- 탐지: 트랜잭션 안에서 `EXPLAIN (ANALYZE) EXECUTE`로 RI 형태 쿼리를 실행했을 때 `IDX_vfs_node_namespace_id_blob_id`나 `UQ_vfs_node_child_name`에 `Filter: id`와 큰 `Rows Removed by Filter`가 보이면 위험하다. `auto_explain`의 `log_triggers`로도 볼 수 있다.
- 회피(테스트): 시드 뒤, 측정 직전에 `ANALYZE vfs_node`를 실행한다. `bulk-limits.ts`의 `flat-cp`가 이 형태다.
- 회피(운영): 새 설치 직후 대량 cp 전에 `ANALYZE vfs_node`를 실행한다.
- 회귀 검증: `apps/api/test/persistence/vfs-node.repository.shared-tests/bulk-limits.ts`가 PG 12,000개 cp를 3,500ms 상한으로 확인한다. `ANALYZE` 없이 실행하면 6.6초라 실패한다.
- 남는 위험:
  - 변경 노드 조회(`captureChangeFeedNodes`의 `id IN` 250개)는 통계 없는 PG에서 `IDX_..._blob_id` bitmap scan을 골랐다. N=12,000에서 0.9ms, N=100,000에서 8ms였고 N=1,000,000에서는 `UQ`를 썼다. 청크당 비용이 작아 따로 고치지 않았다.
  - PG 17 서버의 계획은 측정하지 않았다.
