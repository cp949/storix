# 삭제가 끝난 namespace의 행은 보존 기간 뒤 물리 삭제한다

## 상태

승인됨 (2026-10-02)

## 배경

- namespace 삭제는 데이터를 제거한 뒤 `namespace` 행을 `DELETED` tombstone으로 남긴다(ADR-0032). 삭제 operation(`namespace_deletion`)과 삭제 receipt(`namespace_deletion_receipt`)도 남는다.
- 회원마다 namespace를 만드는 배포에서는 탈퇴한 회원 수만큼 이 행이 영구히 쌓인다.
- 이름 재사용은 접수 커밋부터 가능하므로 tombstone이 이름 충돌을 막는 것은 아니다.
- 삭제 receipt와 operation이 namespace FK를 가진다.

## 결정

- `namespace_deletion.completed_at`부터 `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`(기본 30일)가 지난 `COMPLETED` operation의 namespace를 GC 단계 `deleted-namespace-purge`가 물리 삭제한다. 단계 예산과 재개 위치는 ADR-0033을 따른다.
- 대상은 operation `phase = 'COMPLETED'`이고 namespace `status = 'DELETED'`인 행이다. DELETING·보류·정산 미확정은 대상이 아니다. object 삭제와 upload 정산이 끝났다는 `COMPLETED`의 의미를 그대로 쓴다.
- namespace마다 한 트랜잭션으로 FK 순서(삭제 receipt, upload 사용량(0 값), operation, namespace)대로 지운다. 남은 참조 행이 있으면 FK 위반으로 롤백하고 건너뛴다.
- 생성 receipt(`idempotency_key`)는 대상이 아니다. ADR-0034의 보존 기간을 따른다. `audit_log`는 논리 참조만 가지며 건드리지 않는다.
- migration `AddNamespaceDeletionCompletedIndex`가 `(completed_at, namespace_id) WHERE phase = 'COMPLETED'` 인덱스를 만든다.
- 물리 삭제 뒤 조회·삭제 상태·삭제 재요청은 404 `NAMESPACE_NOT_FOUND`다. 보존 기간 안에서는 지금처럼 `DELETED` 응답과 최초 202 재생이다.

## 검토한 대안

- **영구 보존**: 코드 변경이 없지만 탈퇴 회원 수만큼 행이 영구히 누적된다. 요구(누적 데이터 보존 정책)를 충족하지 않는다. 기각.
- **더 긴 기간(90일)**: 조회·재생 보장 기간이 길어지는 대신 행이 3배 오래 남는다. 기본값은 30일로 하고 env로 바꾸게 했다.
- **삭제 접수 시점 기준**: 정리가 길게 걸린 namespace의 보존 기간이 줄어든다. 완료 시점(`completed_at`)을 기준으로 한다.

## 결과와 유지 비용

- 물리 삭제는 되돌릴 수 없다. 삭제된 namespace의 복구에는 삭제 전 백업이 필요하다. 위험도는 높다.
- 설정 파일에 적은 namespace가 물리 삭제되면 그 설정으로는 시작할 수 없다(존재하지 않는 namespace 참조 거부, `docs/design/06-vfs-capabilities.md`). 삭제한 namespace는 설정에서 지운다. 기본 활성 목록(`defaultEnabledCapabilities`)을 쓰는 배포는 영향이 없다.
- 보존 기간 안에서만 삭제 상태 조회와 삭제 재요청 재생이 보장된다.
- 건너뛴 후보(남은 참조 행)는 GC 로그에 경고로 남고 다음 실행에서 다시 후보가 된다.
