# Quota는 보존 구성요소별 검사와 제외 정책을 지원한다

## 상태

승인됨 (2026-10-02)

## 결정

- 조회 총량은 live·trash·snapshot bytes 합계로 유지한다.
- namespace 설정은 trash와 snapshot을 quota 검사에서 독립적으로 제외할 수 있다. 응답은 총량과 검사 대상 `enforcedBytes`를 구분한다.
- mutation 검사에는 구성요소별 delta를 사용한다. 복구·이동을 전체 합계 delta만으로 평가하지 않는다.
- retained trash bytes에는 namespace quota에서 상속하는 별도 상한을 둔다. 상한 하향은 기존 항목을 지우지 않는다.

## 대안

- 총합만 비교하면 제외된 구성요소에서 live로 옮기는 복구가 quota를 우회할 수 있다.
- 제외된 데이터를 조회 총량에서 빼면 저장 중인 논리 데이터 규모를 숨기고 기존 `usedBytes` 의미를 깨뜨린다.
- 상한 하향 시 기존 trash를 강제 삭제하면 설정 변경이 데이터 파괴를 일으킨다.

## 결과

Restore·snapshot·trash 경로는 각 구성요소의 양수 delta를 검사한다. 이미 상한을 넘은 데이터는 줄이는 경로로 정리할 수 있다.
