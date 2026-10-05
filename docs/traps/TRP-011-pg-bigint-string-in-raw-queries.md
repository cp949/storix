# TRP-011 PostgreSQL bigint는 raw SQL 결과에서 문자열이라 엔티티 transformer를 우회한다

- 상태: ACTIVE
- 적용 조건: `vfs_node.version`처럼 PostgreSQL `bigint` 컬럼을 number로 다루는 엔티티를 `manager.query`·`dataSource.query` 같은 raw SQL로 읽을 때

## 오해하기 쉬운 신호

SQLite에서는 같은 쿼리가 number를 돌려준다.
`bigint` 컬럼에 `transformer`를 달았으므로 모든 읽기가 number라고 믿기 쉽다.
값이 작으면 문자열 `"2"`가 와도 `Number.isSafeInteger`·`>` 비교 밖에서는 티가 나지 않는다.

## 원인

- `pg` 드라이버는 `bigint`(int8)를 문자열로 돌려준다. 정밀도 손실을 피하려는 기본 동작이다.
- TypeORM `transformer.from`은 엔티티 하이드레이션 경로에서만 실행된다. raw 쿼리 결과에는 적용되지 않는다.
- SQLite(`better-sqlite3`)는 number를 돌려준다. 드라이버 차이로 SQLite 테스트만 통과한다.
- 2026-10-05 `vfs_node.version`을 `bigint`로 바꿀 때(GitHub 이슈 #41) raw 두 곳이 해당했다. `captureSnapshotRows`는 `encodeRevision(row)`에 문자열을 넘겨 `Number.isSafeInteger` 실패 → `VfsRevisionExhaustedError`가 났을 것이고, `findRecursive`는 `version`이 문자열로 응답에 실렸다.

## 탐지/회피

- 탐지: PostgreSQL 통합 테스트에서 값을 2^31 초과(예: 3,000,000,000)로 만든 뒤 raw 경로가 돌려주는 값을 `toEqual`로 단언한다. `toBe`·`toEqual`은 `"3000000000"`과 `3000000000`을 구분한다.
- 회피: raw 결과를 도메인 값으로 옮기는 지점에서 `Number(row.version)`으로 정규화한다. 행 타입은 `number | string`으로 둔다.
- 해당하지 않는 경로: `Repository`·`QueryBuilder`로 엔티티를 읽는 경로(`findOneBy` 등)는 `transformer`가 적용된다. `UPDATE ... SET version = version + 1`은 읽지 않으므로 무관하다.
- 전역 int8 파서(`types.setTypeParser(20, …)`)는 쓰지 않는다. `blob.size`·byte count의 문자열 계약이 깨진다(api ADR-0044).
- 회귀 검증: `apps/api/test/persistence/vfs-node.repository.shared-tests/mutation-revisions.ts`의 "version이 int4 상한을 넘어도" 테스트(PostgreSQL·SQLite).
