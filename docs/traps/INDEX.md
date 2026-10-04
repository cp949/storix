# 함정 색인

`docs/agents/rubber-workflow.md` "함정 → 장기 문서화" 기준(재발 조건 특정 가능, 성공처럼 보이는 신호, 재발 가능성)을 모두
만족해 승격한 항목이다. ID는 `TRP-NNN`(001부터)이며 삭제한 ID는 재사용하지 않는다.

| ID      | 제목                                                               | 상태   | 적용 조건                                                                   |
| ------- | ------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------- |
| TRP-001 | 경합 계약이 한 분기만 실행하고 통과한다                            | ACTIVE | 동시 요청 두 개의 "성공이거나 거부"를 허용하는 계약을 쓸 때                 |
| TRP-002 | Node 내장 fetch가 스트림 요청 본문을 요청이 끝날 때까지 보유한다   | ACTIVE | Node 24.20.0 내장 `fetch`에 스트림 요청 본문을 넘겨 큰 파일을 업로드할 때   |
| TRP-003 | Counter backfill의 correlated query에 parent 인덱스가 필요하다     | ACTIVE | 부모별 child count를 기존 tree row에 backfill하는 migration을 작성할 때     |
| TRP-004 | GC 없이 잰 arrayBuffers 증가량은 힙 크기와 GC 위상에 따라 흔들린다 | ACTIVE | `process.memoryUsage().arrayBuffers`의 전후 차이로 버퍼 상한을 단언할 때    |
| TRP-005 | SQLite는 varchar 길이를 강제하지 않아 PostgreSQL 22001을 놓친다    | ACTIVE | 클라이언트 문자열 입력을 `varchar(N)` 컬럼에 저장하는 코드를 추가·변경할 때 |
