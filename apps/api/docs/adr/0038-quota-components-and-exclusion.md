# Quota는 보존 구성요소별 검사와 제외 정책을 지원한다

## 상태

승인됨 (2026-10-02)

## 결정

- 조회 총량은 live·trash·snapshot bytes의 합계다.
- namespace 설정으로 trash와 snapshot을 quota 검사에서 각각 제외할 수 있다.
- 응답은 총량과 검사 대상 `enforcedBytes`를 구분한다.
- mutation 검사는 구성요소별 delta를 쓴다.
- 복구·이동을 전체 합계 delta만으로 평가하지 않는다.
- retained trash bytes에는 별도 상한을 둔다.
  상한은 namespace quota에서 상속한다.
- 상한을 낮춰도 기존 항목은 삭제하지 않는다.

## 대안

- **총합만 비교**: 제외된 구성요소에서 live로 복구하면 quota를 우회할 수 있다.
- **제외된 데이터를 조회 총량에서도 제외**:
  - 저장 중인 논리 데이터 규모를 숨긴다.
  - 기존 `usedBytes` 의미가 바뀐다.
- **상한 하향 시 기존 trash 강제 삭제**: 설정 변경이 데이터 삭제를 일으킨다.

## 결과

- Restore·snapshot·trash 경로는 구성요소별 양수 delta를 검사한다.
- 이미 상한을 넘은 데이터는 사용량을 줄이는 경로로 정리할 수 있다.
