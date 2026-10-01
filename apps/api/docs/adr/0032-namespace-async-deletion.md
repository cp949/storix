# Namespace 전체 삭제는 관리자 접수와 GC 정리로 분리한다

## 상태

채택한다.

## 배경

- namespace root의 파일 삭제는 root를 제거하지 않는다.
- namespace 소유 데이터에는 live Node 외에 snapshot·휴지통·upload session·과금 중 staging이 있다.
- namespace 행을 직접 지우면 Blob 참조·quota·staging 정산을 함께 보장하기 어렵다.
- object storage I/O와 orphan grace는 HTTP 요청 하나의 완료 범위를 넘는다.
- 삭제 중 새 writer와 upload admission도 차단해야 한다.

## 결정

1. 관리자 key만 허용하는 `POST /api/v2/admin/namespaces/{namespaceId}/delete`로 삭제를 접수한다.
   - api ADR-0018의 `POST` + 동사형 경로를 따른다.
   - body 없는 요청과 `Idempotency-Key`를 사용한다.
2. root·usage 잠금 아래 ACTIVE → DELETING·operation·최초 응답 receipt를 같은 transaction에서 저장한다.
   - 접수는 202와 상태 조회 `Location`을 반환한다.
   - `GET /api/v2/admin/namespaces/{namespaceId}/deletion`은 현재 상태를 조회한다.
   - 최초 receipt는 완료 뒤에도 최초 응답을 재생한다.
3. DELETING부터 데이터 접근·기존 변경 receipt replay·새 upload admission을 차단한다.
   - writer는 잠금 안에서 ACTIVE를 재검사한다.
   - 전달 중인 스트림의 즉시 중단과 기존 presigned URL 취소는 보장하지 않는다.
4. 이름은 DELETING 전환 커밋부터 재사용한다.
   - 같은 이름의 새 namespace는 새 UUID다.
   - 기존 생성 receipt는 원래 UUID와 응답을 유지한다.
   - 정리는 이름을 사용하지 않는다.
5. 기존 GC에서 UPLOADS → METADATA → OBJECTS → COMPLETED를 영속 상태로 재개한다.
   - root·phase 재검사와 배치 transaction으로 중복 정산을 막는다.
   - 기존 orphan grace와 object 삭제 확인을 유지한다.
   - 미정착 staging tombstone은 과금 해제와 DELETED 전환을 보류한다.
6. DELETED 뒤에도 namespace tombstone·삭제 operation·삭제 receipt를 보존한다.
   - 자동 만료·삭제 취소·복원 API는 제공하지 않는다.
   - 완료는 추적 데이터의 정리를 뜻한다. metadata 없는 object·backup·과거 object 버전·외부 cache는 별도다.

현재 세부 계약과 잠금·정산 규칙은 [namespace 관리자 삭제 설계](../../../../docs/design/13-namespace-deletion.md)에 둔다.

## 검토한 대안

| 대안                                    | 채택하지 않는 이유                                                      |
| --------------------------------------- | ----------------------------------------------------------------------- |
| 빈 namespace만 동기 삭제                | 호출자가 snapshot·휴지통·upload까지 먼저 정리해야 한다.                 |
| 모든 데이터를 HTTP 안에서 동기 삭제     | 외부 I/O·grace·재시작을 한 응답 안에서 보장하기 어렵다.                 |
| namespace DB 행 수동 삭제               | Blob 참조·quota·staging의 정산과 동시 writer 차단을 보장하지 않는다.    |
| 미정착 PUT를 lease 만료만으로 완료 처리 | 늦은 PUT가 object를 재생성할 수 있다. PUT 종료와 과금 해제 근거가 없다. |

## 결과와 유지 비용

- API·GC 버전 혼합 중 삭제를 접수하면 구버전 writer가 비활성 namespace에 반영할 수 있다. 함께 교체한다.
- GC 예약이 없거나 PUT 정착을 증명할 수 없으면 DELETING을 유지한다. 완료 시간 상한은 없다.
- tombstone·receipt·audit가 누적된다. 자동 보존 기한은 별도 결정이 필요하다.
- cleanup의 manifest 정산 규칙은 공개 snapshot·trash 삭제와 별도로 구현한다.
- 공개 삭제 규칙 변경 시 cleanup의 참조·counter·manifest 정산도 검토한다.
- 새 데이터 경로는 root·usage 잠금 안 ACTIVE 재검사와 비활성 receipt 차단을 함께 적용한다.

```text
위험도: 높음
롤백: 삭제 접수 뒤 ACTIVE 복귀를 지원하지 않는다. 제거한 데이터는 접수 이전 백업으로 복원해야 한다.
```
