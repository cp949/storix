# 재개 업로드는 분리된 staging 객체와 DB 완료 커밋으로 공개한다

대용량 파일을 중단 뒤 재개하려면 완료 전 조각을 보존해야 한다.
조각을 VFS 파일로 노출하거나 같은 object key에 덮어쓰면 다음 문제가 생긴다.

- 부분 파일이 공개된다.
- 늦은 삭제 콜백이 새 데이터를 삭제할 수 있다.
- quota를 원자적으로 검사해야 한다.

## 결정

조각 저장 규칙:

- 조각은 `upload-staging/<새 UUID>` key로 저장한다.
- DB part row에서만 참조한다.
- 예약마다 새 UUID를 만든다.
- 삭제된 index를 다시 예약해도 key를 재사용하지 않는다.
- 예약 바이트는 실제 객체 삭제 확인 전까지 전역·namespace 사용량에 포함한다.
- 암호화 namespace의 staging도 암호화한다.
- 공개 VFS 경로는 staging을 참조하지 않는다.

완료 처리 순서:

1. 조각을 검증하며 별도 최종 Blob에 스트리밍한다.
2. `withMutation`의 DB 트랜잭션에서 다음 항목을 함께 확정한다.
   - 선행 조건.
   - 논리 quota.
   - Node/Blob/revision.
   - 세션 완료.

FINALIZING 작업자는 token과 lease로 fencing한다.
스트리밍 동안 heartbeat를 갱신한다.
DB 커밋 전 객체는 공개하지 않는다.
커밋에 실패한 미참조 객체는 삭제를 시도하거나 orphan GC에 맡긴다.
GC는 활성 staging key를 보호한다.
종결 조각의 삭제는 재시도한다.

## 검토한 대안

- **VFS 임시 Node로 조각 노출:** 조회·snapshot·quota 경로마다 부분 파일을 숨기는 예외가 필요하다.
- **고정 staging key에 덮어쓰기:** 이전 실패의 지연된 삭제가 새 조각을 제거할 수 있다.
- **객체 저장과 DB 공개를 하나의 원자 작업으로 취급:**
  - 객체 저장소와 DB 사이에 분산 트랜잭션이 없다.
  - DB에서 최종 참조만 원자적으로 공개한다.
  - 미참조 객체는 GC로 회수한다.

## HTTP 메소드와 기존 ADR 정합성

승인된 resumable upload 계약은 다음 메소드를 쓴다.

- part 저장: `PUT`.
- session 취소: `DELETE`.

api ADR-0018은 사내 네트워크가 GET/POST만 허용한다고 전제한다.
이 전제를 적용하는 배치에서는 재개 업로드 경로가 차단될 수 있다.
해당 환경에 배포하려면 다음 중 하나가 필요하다.

- 네트워크 허용 목록 조정.
- 별도 API 계약 변경 승인.

이 ADR은 재개 업로드 계약의 승인을 기록한다.
api ADR-0018의 네트워크 전제를 일반적으로 폐기하지 않는다.

기존 세션 테이블의 완료 행에서는 이전 생성 request ID를 복구할 수 없다.
migration은 완료 요청 ID를 생성 ID로 복사하지 않는다.
과거 완료 행의 생성 replay는 해당 재시도 request ID를 반환한다.
신규 생성은 별도 컬럼에 원래 ID를 보존한다.

## 결과

- 임시 객체는 삭제 전까지 staged quota를 소비한다.
  GC 실행과 orphan grace가 운영 조건이다.
- 완료 실패 후 미참조 최종 객체가 잠시 남을 수 있다.
- 프로세스 중단으로 PUT 정착 여부가 불명확하면 예약량을 자동 해제하지 않는다.
  안전한 과금 상한을 유지하기 위한 규칙이다.
- 삭제 완료 전 같은 index 재시도는 `409 VFS_UPLOAD_PART_IN_PROGRESS`다.
  삭제 완료 후에도 미정착 예약의 quota는 유지된다.
  재시도는 남은 전역·namespace quota가 있을 때만 새 staging key로 성공한다.
- 미정착 예약이 quota를 소진하면 같은 세션과 다른 업로드도 실패한다.
  오류는 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`다.
  현재 자동·관리자 정산 API는 없다.
- tombstone이 남아 있으면 migration `down`을 거부한다.
  기존 API로 세션을 비활성화·종결하는 것만으로 롤백 조건을 충족하지 못할 수 있다.
  이미 공개된 파일과 진행 중 세션의 의미도 자동으로 되돌리지 않는다.
