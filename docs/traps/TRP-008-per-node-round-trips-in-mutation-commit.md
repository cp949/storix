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
- 커밋 단계 밖에서도 같은 구조가 있었다. `mkdir -p`·`parents=true` 생성이 새 디렉터리마다 `markAncestorChain`으로 조상 체인을 root까지 다시 조회해, 깊이 N에서 쿼리가 N²/2였다(SQLite 깊이 1,000 504,514개·14.6초, 깊이 2,000 2,009,018개·57.3초, GitHub 이슈 #42). 그동안 SQLite 프로세스의 다른 요청이 모두 멈춘다.
- change feed checkpoint가 있으면 같은 구조가 한 번 더 있었다. `markAncestorChain`과 `lockParentChain`이 `trackChangeFeedBefore(tx, [id])`를 노드 하나씩 불러, 호출마다 `captureChangeFeedNodes`가 그 노드의 경로를 root까지 `findOneBy`로 다시 계산했다. 깊이 800 기존 체인의 put이 checkpoint 없이 2,426쿼리인데 checkpoint가 있으면 323,641쿼리·10.3초였다(GitHub 이슈 #43). #34 회귀 테스트가 checkpoint 없이 측정해 놓쳤다.

## 탐지/회피

- 탐지: 쿼리 개수를 센다. change feed checkpoint를 만든 경로도 함께 센다(checkpoint가 없으면 변경 전 상태를 읽지 않아 이 비용이 안 보인다). 노드 수나 깊이를 2배로 늘렸을 때 쿼리 수가 2배 이상 늘면 위험하다. 시간은 DB 지연·통계 상태에 따라 흔들려 탐지 지표로 부적합하다.
- 회피:
  - 노드 id를 `IN` 청크(`NODE_BULK_CHUNK_SIZE`, `captureChangeFeedNodes`는 250)로 한 번에 읽는다.
  - 부모 해석은 한 번 읽은 행을 `Map`에 두고 메모이즈한다. 변경 집합 밖 조상만 추가로 조회한다. `captureChangeFeedNodes`가 이 형태다.
  - 버전 증가는 `UPDATE … WHERE id IN (…) AND version < :max`로 청크 처리하고 `affected !== 청크 크기`면 `VfsRevisionExhaustedError`로 거부한다.
  - 조상 변경 전 상태는 `trackChangeFeedBefore(tx, 조상 전체)`로 한 번에 읽고, `captureChangeFeedNodes`의 `known`(= `tx.feedBefore`)으로 이미 읽은 부모의 경로를 재사용한다.
  - 같은 트랜잭션에서 조상 체인을 여러 번 걷는 코드는 `tx.ancestorChainMarked`처럼 걸은 노드를 기억하고 만나면 멈춘다. `markAncestorChain`이 이 형태다.
- 회귀 검증: `apps/api/test/persistence/vfs-node.repository.shared-tests/bulk-limits.ts`가 `countQueries` 헬퍼(DataSource `logger.logQuery`를 감싼다)로 쿼리 수를 단언한다.
  - 평평한 12,000개 cp: 300개 미만이다. 수정 후 실측은 114개다.
  - 깊이 1,500 체인 mv·cp: 100개 미만이다. 수정 후 실측은 mv 25개, cp 30개다.
  - 수정 전 SQLite에서 36,068개와 1,128,766개로 실패했다.
  - checkpoint를 만든 깊이 300 체인 put·touch·mv: 레벨당 8개 미만이다. 수정 후 실측은 깊이 800에서 약 4,040개(레벨당 5개)다. 수정 전 SQLite에서 46,379·46,379·46,373개로 실패했다.
  - 깊이 300 `mkdir -p`·parents put: 레벨당 8개 미만이다. 수정 후 실측은 레벨당 5개다(깊이 2,000 10,018개·0.46초). 수정 전 SQLite에서 46,361개와 46,670개로 실패했다.
- 남는 위험:
  - 변경 집합 밖의 깊은 조상은 여전히 부모를 한 단계씩 조회한다. 깊이에 선형이고 노드 수에는 곱해지지 않는다.
  - 경로 상한(4096바이트)이 허용하는 깊이 약 2,048의 `mkdir -p`는 SQLite에서 약 0.5초 동안 프로세스의 다른 요청을 멈춘다. 별도 깊이 상한은 두지 않았다.
  - checkpoint가 있을 때 깊이 800 put은 4,041쿼리·0.2초로 checkpoint 없는 경우(2,426쿼리)의 약 1.7배다. 남는 레벨당 약 5쿼리는 선형이라 재귀 CTE로 줄이지 않았다(TRP-007).
  - PostgreSQL에서 12,000개 cp가 수정 뒤에도 6.6초인 것은 `FK_vfs_node_parent` RI 계획이 작은 테이블 기준으로 캐시된 탓이다. 원인은 TRP-009다(GitHub 이슈 #35).
