# 디렉터리 이동에 동기 처리 노드 수 상한을 둔다

## 상태

승인됨 (2026-10-05)

## 배경

`moveNode`의 하위 노드 조회에는 상한이 없었다(GitHub 이슈 #26).
copy는 `STORIX_MAX_SYNC_COPY_NODES`, rm은 `STORIX_MAX_SYNC_DELETE_NODES`로 제한한다.

이동은 root lock을 쥔 한 트랜잭션에서 하위 노드마다 revision UPDATE와 경로 계산용 부모 조회를 실행한다.
쿼리 수는 대략 `N × (3 + 하위 노드의 평균 깊이)`이고(결정 시점, 이후 배치 조회로 바뀜), 이동하는 동안 같은 namespace의 mutation이 멈춘다.
SQLite는 프로세스 전체 DB 접근이 멈춘다.

SQLite 파일 DB에서 실측한 소요 시간(2026-10-05, Postgres는 측정하지 않음):

- 평평한 트리 하위 노드 20,000개: 약 2.2초.
- 깊이 10 트리 하위 노드 20,000개: 약 4.7초.
- 깊이 100 트리 하위 노드 20,000개: 약 30초. SQLite 쿼리 게이트 대기 상한과 같다.

## 결정

- 이동 대상 자신을 포함한 subtree 노드 수가 상한을 넘으면 변경 전에 413 `VFS_MOVE_LIMIT_EXCEEDED`로 거부한다.
- FILE 이동은 노드 하나이므로 상한과 무관하다.
- 판정은 이동 대상 root의 row lock을 잡은 뒤 하위 노드 조회에 `LIMIT`을 걸어 한다. 변경과 change feed 기록은 판정 뒤에 시작한다.
- 상한은 `STORIX_MAX_SYNC_MOVE_NODES`(기본 10,000)이고 전역 hard ceiling이다.
- `namespace.max_sync_move_nodes`로 namespace별 override를 둔다. 값이 있으면 `min(namespace 값, 전역값)`을 쓴다.
- 값 설정 API는 만들지 않는다. api ADR-0008의 copy·rm 상한과 같다.
- 기본값은 copy·rm(1,000)보다 크게 잡는다. 디렉터리 rename은 1,000개를 넘는 경우가 흔하다.
- 10,000개에서 걸리는 시간은 실측이 아니라 선형 외삽한 추정이다.
  - 평평한 트리 약 1.1초.
  - 깊이 10 트리 약 2.4초.
  - 깊이 100 트리 약 15초.

## 한계

- 노드 수 상한은 깊이를 제한하지 않는다. 같은 노드 수에서도 깊은 트리가 더 오래 걸린다.
- 경로 4096바이트 상한이 깊이를 간접적으로 제한한다.
- 이 상한은 root lock 점유 시간의 보증이 아니라 비용의 1차 제한이다.
- 이동 결과의 하위 경로가 4096바이트를 넘는 트리는 이 상한과 별개로 `VFS_INVALID_PATH`로 실패한다.

## 대안

- **하위 노드 revision bump·경로 계산을 일괄 SQL로 변경**:
  - 쿼리 수는 줄지만 노드별 change feed 이벤트와 응답의 `affectedRevisions` 항목 수는 줄지 않는다.
  - 상한 없이는 root lock 점유 시간을 제한하지 못해 이번 결정에서 제외했다.
  - 상한을 키울 때 선행하는 별도 작업으로 남긴다.
  - 이후 GitHub 이슈 #33·#34에서 revision bump와 경로 계산을 배치 조회로 바꿨다(TRP-008). 상한은 root lock 점유 시간의 1차 제한이라 유지한다.
- **copy 상한 값을 재사용**: 의미가 다른 두 연산이 한 값에 묶여 운영자가 따로 조정할 수 없다.
- **깊이를 반영한 가중 상한**: 구현·설명 비용이 크고 경로 길이 상한이 깊이를 간접 제한한다.

## 결과

- 이전에 성공하던 10,000개 초과 subtree 이동이 413으로 바뀐다. 이 값을 넘는 정당한 이동은 전역 상한 `STORIX_MAX_SYNC_MOVE_NODES`를 올려야 한다. namespace override가 더 낮으면 그 값도 올려야 한다.
- 오류 코드 `VFS_MOVE_LIMIT_EXCEEDED`가 추가된다. 조건부 mutation receipt는 이 413을 다른 결정적 상한 오류와 같이 재생한다.
- `namespace` 테이블에 마이그레이션 `AddNamespaceMoveLimit1791700000022`가 추가된다.
