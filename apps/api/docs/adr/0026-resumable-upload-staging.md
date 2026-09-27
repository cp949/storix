# 재개 업로드는 분리된 staging 객체와 DB 완료 커밋으로 공개한다

대용량 파일을 중단 뒤 재개하려면 완료 전 조각을 보존해야 한다. 조각을 VFS 파일로 노출하거나 같은 object key에 덮어쓰면 부분 파일 노출, 늦은 삭제 콜백의 새 데이터 삭제, 원자적 quota 검사가 생긴다.

## 결정

조각은 `upload-staging/<새 UUID>` key로 저장하고 DB part row에서만 참조한다. 예약할 때마다 UUID를 새로 만들며 삭제된 index를 다시 예약해도 key를 재사용하지 않는다. 예약 바이트는 실제 객체 삭제 확인 전까지 전역·namespace 사용량에 포함한다. 암호화 namespace에서는 staging도 암호화한다. 공개 VFS 경로는 staging을 참조하지 않는다.

완료는 조각을 검증하며 별도 최종 Blob에 스트리밍한 뒤, `withMutation`의 DB 트랜잭션에서 조건·논리 quota·Node/Blob/revision·세션 완료를 함께 확정한다. FINALIZING 작업자는 token과 lease로 fencing하며 스트리밍 동안 heartbeat를 갱신한다. DB 커밋 전 객체 생성은 비가시적이고, 커밋 실패의 미참조 객체는 삭제를 시도하거나 orphan GC에 맡긴다. GC는 활성 staging key를 보호하고 종결 조각 삭제를 재시도한다.

## 검토한 대안

- **VFS 임시 Node로 조각 노출:** 조회·snapshot·quota 경로마다 부분 파일을 숨기는 예외가 필요하다.
- **고정 staging key에 덮어쓰기:** 이전 실패의 지연된 삭제가 새 조각을 제거할 수 있다.
- **객체 저장과 DB 공개를 한 원자 작업으로 취급:** 객체 저장소와 DB 사이에 분산 트랜잭션이 없다. DB에서 최종 참조만 원자적으로 공개하고 미참조 객체를 GC로 회수한다.

## HTTP 메소드와 기존 ADR 정합성

이 API는 승인된 resumable upload 계약에 따라 part 저장 `PUT`과 session 취소 `DELETE`를 사용한다. 이는 사내 네트워크가 GET/POST만 허용한다는 ADR-0018의 전제를 적용하는 배치에서는 해당 경로가 차단될 수 있는 예외다. 그러한 환경에 배포할 때는 네트워크 허용 목록을 조정하거나 별도 API 계약 변경을 승인해야 한다. 이 ADR은 해당 API 계약이 승인된 것을 기록하며 ADR-0018의 전제를 일반적으로 폐기하지 않는다.

기존 세션 테이블에서 이미 완료된 행은 이전 생성 request ID를 복구할 수 없다. migration은 완료 요청 ID를 생성 ID로 오인해 복사하지 않으며, 그런 과거 행의 생성 replay에는 해당 재시도 request ID를 반환한다. 신규 생성은 별도 컬럼으로 원래 ID를 보존한다.

## 결과

임시 객체가 삭제되기 전까지 staged quota를 소비하며 GC 실행과 orphan grace가 운영 조건이다. 완료 실패에서 미참조 최종 객체가 잠시 남을 수 있다. 프로세스 중단으로 PUT 정착 여부가 불명확하면 안전한 과금 상한을 위해 해당 예약량을 자동 해제하지 않는다. 삭제 완료 전 같은 index 재시도는 `409 VFS_UPLOAD_PART_IN_PROGRESS`; 삭제 완료 후에도 quota는 유지되므로, 재시도는 남은 전역·namespace quota가 있을 때만 새 staging key로 성공한다. 미정착 예약이 quota를 소진하면 같은 세션과 다른 업로드가 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`를 받으며 현재 자동·관리자 정산 API는 없다. 이 상태의 migration `down`은 tombstone이 남아 있으면 거부되므로, 롤백 전에 기존 API로 세션을 비활성화·종결하는 것만으로 충분하지 않을 수 있다. 이미 공개된 파일과 진행 중 세션의 의미도 자동 역전하지 않는다.
