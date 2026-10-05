# TRP-008 변경 노드마다 DB를 개별 조회하면 노드 수·깊이에 비례해 왕복이 늘어난다

- 상태: ACTIVE
- 적용 조건: `withMutation` 안이나 커밋 직전 단계에서 `tx.changed`·하위 트리 같은 노드 집합을 반복하며 `findOneBy`·`UPDATE`를 노드마다 실행하는 코드를 추가하거나 바꿀 때.

## 오해하기 쉬운 신호

결과가 맞고 노드 수백 개의 테스트가 모두 통과한다.
SQLite 로컬 실행이 빨라 보인다(평평한 12,000개 cp가 1.4초).
PostgreSQL에서는 왕복 지연이 곱해져 같은 코드가 약 20초가 된다.
SQLite에서도 한 줄로 이어진 깊은 체인에서는 깊이 1,500 mv·cp가 약 34초였다(GitHub 이슈 #33·#34).

## 원인

- `bumpAndReadChangedNodes`가 `tx.changed`의 노드마다 `findOneBy`로 노드를 읽고, 경로를 만들려고 부모를 루트까지 `findOneBy`로 거슬러 올라갔다. 메모이즈가 없었다.
- 쿼리 수는 노드 수 N과 평균 깊이 d에 대해 `N × (1 + d)`였다.
  - 평평한 12,000개 cp: 쿼리 36,043개 중 36,004개(99.9%)가 이 단계였다.
  - 깊이 1,500 체인 mv·cp: 변경 노드 i의 부모 체인이 길이 i라 쿼리 약 113만 개(`d(d+1)/2`)였다.
- 쿼리 자체는 서버에서 0.024ms다(`EXPLAIN ANALYZE`). 시간은 왕복과 TypeORM·JS 오버헤드(SQLite 쿼리당 약 29µs)가 만든다.
- `increment=true` 노드(mv·재귀 변경의 하위 노드)마다 UPDATE를 1회씩 실행하는 첫 루프도 같은 구조였다.

## 탐지/회피

- 탐지: 쿼리 개수를 센다. 노드 수나 깊이를 2배로 늘렸을 때 쿼리 수가 2배 이상 늘면 위험하다. 시간은 DB 지연·통계 상태에 따라 흔들려 탐지 지표로 부적합하다.
- 회피:
  - 노드 id를 `IN` 청크(`NODE_BULK_CHUNK_SIZE`, `captureChangeFeedNodes`는 250)로 한 번에 읽는다.
  - 부모 해석은 한 번 읽은 행을 `Map`에 두고 메모이즈한다. 변경 집합 밖 조상만 추가로 조회한다. `captureChangeFeedNodes`가 이 형태다.
  - 버전 증가는 `UPDATE … WHERE id IN (…) AND version < :max`로 청크 처리하고 `affected !== 청크 크기`면 `VfsRevisionExhaustedError`로 거부한다.
- 회귀 검증: `apps/api/test/persistence/vfs-node.repository.shared-tests/bulk-limits.ts`가 `countQueries` 헬퍼(DataSource `logger.logQuery`를 감싼다)로 쿼리 수를 단언한다.
  - 평평한 12,000개 cp: 300개 미만이다. 수정 후 실측은 114개다.
  - 깊이 1,500 체인 mv·cp: 100개 미만이다. 수정 후 실측은 mv 25개, cp 30개다.
  - 수정 전 SQLite에서 36,068개와 1,128,766개로 실패했다.
- 남는 위험:
  - 변경 집합 밖의 깊은 조상은 여전히 부모를 한 단계씩 조회한다. 깊이에 선형이고 노드 수에는 곱해지지 않는다.
  - PostgreSQL에서 12,000개 cp가 수정 뒤에도 6.6초인 것은 `FK_vfs_node_parent` RI 계획이 작은 테이블 기준으로 캐시된 탓이다. 원인은 TRP-009다(GitHub 이슈 #35).
