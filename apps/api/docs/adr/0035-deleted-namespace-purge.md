# 삭제가 끝난 namespace의 행은 보존 기간 뒤 물리 삭제한다

## 상태

승인됨 (2026-10-02)

## 배경

- api ADR-0032는 데이터 정리 후 `namespace` 행을 `DELETED` tombstone으로 남긴다.
- 삭제 operation(`namespace_deletion`)과 삭제 receipt(`namespace_deletion_receipt`)도 보존한다.
- 회원별 namespace 배포에서는 탈퇴한 회원 수만큼 행이 영구히 쌓인다.
- 이름은 삭제 접수 커밋부터 재사용할 수 있다.
  tombstone은 이름 충돌을 막기 위한 행이 아니다.
- 삭제 receipt와 operation은 namespace FK를 갖는다.

## 결정

- GC의 `deleted-namespace-purge` 단계가 보존 기간을 넘긴 namespace를 물리 삭제한다.
  - 기준 시각: `namespace_deletion.completed_at`.
  - 보존 기간: `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`(기본 30일).
  - 단계 예산과 재개 위치: api ADR-0033.
- 삭제 대상은 다음 조건을 모두 충족해야 한다.
  - operation의 `phase = 'COMPLETED'`.
  - namespace의 `status = 'DELETED'`.

  DELETING·보류·정산 미확정 상태는 대상이 아니다.
  `COMPLETED`는 object 삭제와 upload 정산이 끝났다는 기존 의미를 유지한다.

- namespace마다 한 트랜잭션에서 FK 순서로 지운다.
  1. 삭제 receipt.
  2. upload 사용량(0 값).
  3. operation.
  4. namespace.

  참조 행이 남아 있으면 FK 위반으로 롤백한다.
  해당 namespace는 건너뛴다.

- 생성 receipt(`idempotency_key`)는 대상이 아니다.
  보존 기간은 api ADR-0034를 따른다.
- `audit_log`는 논리 참조만 갖는다.
  이 단계에서 변경하지 않는다.
- migration `AddNamespaceDeletionCompletedIndex`가 부분 인덱스를 만든다.
  - 컬럼: `(completed_at, namespace_id)`.
  - 조건: `WHERE phase = 'COMPLETED'`.
- 물리 삭제 후 조회·삭제 상태 조회·삭제 재요청은 404 `NAMESPACE_NOT_FOUND`다.
  보존 기간 안에서는 `DELETED` 응답과 최초 202 재생을 유지한다.

## 검토한 대안

- **영구 보존**:
  - 코드 변경은 없다.
  - 탈퇴 회원 수만큼 행이 영구히 누적된다.
  - 누적 데이터 보존 정책 요구를 충족하지 못해 기각했다.
- **90일 보존**:
  - 조회·재생 보장 기간이 길어진다.
  - 행도 30일보다 3배 오래 남는다.
  - 기본값은 30일로 두고 env로 조정할 수 있게 했다.
- **삭제 접수 시점 기준**:
  - 정리가 오래 걸리면 완료 후 보존 기간이 줄어든다.
  - 완료 시점인 `completed_at`을 기준으로 한다.

## 결과와 유지 비용

- 물리 삭제된 namespace가 설정 파일에 남아 있으면 그 설정으로 시작할 수 없다.
  존재하지 않는 namespace 참조는 거부한다(`docs/design/06-vfs-capabilities.md`).
  삭제한 namespace는 설정에서 제거한다.
  `defaultEnabledCapabilities`를 쓰는 배포는 영향이 없다.
- 삭제 상태 조회와 삭제 재요청 재생은 보존 기간 안에서만 보장한다.
- 참조 행이 남아 건너뛴 후보는 GC 경고 로그에 남긴다.
  다음 실행에서 다시 후보가 된다.

```text
위험도: 높음
롤백: 물리 삭제는 되돌릴 수 없다. 삭제된 namespace는 삭제 전 백업으로 복원해야 한다.
```
