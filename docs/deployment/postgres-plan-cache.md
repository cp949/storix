# PostgreSQL 신규 설치 직후 대량 복사

적용 대상: PostgreSQL 백엔드를 새로 설치한 직후, 기본값보다 큰 `STORIX_MAX_SYNC_COPY_NODES`로 노드가 수천 개 이상인 디렉터리를 `cp`하는 경우.

## 현상

`FK_vfs_node_parent`의 RI 쿼리 계획이 테이블이 작을 때 만들어져 backend 세션에 캐시되면, 테이블이 커진 뒤에도 그 계획이 남는다.
계획은 `id`를 Filter로 거르는 인덱스를 써서 조회 1회가 테이블 행 수에 비례한다.
테스트 환경에서 평평한 12,000개 `cp`가 6.6초 걸렸고, `ANALYZE vfs_node` 뒤에는 1.1초였다(원인과 수치는 `docs/traps/TRP-009-pg-cached-fk-plan-from-small-table.md`).

## 권고

- 기본값(`STORIX_MAX_SYNC_COPY_NODES=1000`)이면 조치가 필요 없다.
- 상한을 올려 대량 `cp`를 하기 전에 `vfs_node` 통계를 갱신한다.

  ```bash
  docker compose exec postgres psql -U <사용자> -d <DB> -c 'ANALYZE vfs_node;'
  ```

- `autovacuum`이 켜진 상태에서 첫 `autoanalyze`가 지나면 같은 효과가 난다. 이 시점은 측정하지 않았다.
- `ANALYZE`는 읽기·쓰기를 막지 않는다. 쓰기 중단은 필요 없다.
