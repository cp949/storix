# 재개 업로드는 분리된 staging 객체와 DB 완료 커밋으로 공개한다

대용량 파일을 중단 뒤 재개하려면 완료 전 조각을 보존해야 한다. 조각을 VFS 파일로 노출하거나 같은 object key에 덮어쓰면 부분 파일 노출, 늦은 삭제 콜백의 새 데이터 삭제, 원자적 quota 검사가 생긴다.

## 결정

조각은 `upload-staging/<새 UUID>` key로 저장하고 DB part row에서만 참조한다. 예약할 때마다 UUID를 새로 만들며 삭제된 index를 다시 예약해도 key를 재사용하지 않는다. 예약 바이트는 실제 객체 삭제 확인 전까지 전역·namespace 사용량에 포함한다. 암호화 namespace에서는 staging도 암호화한다. 공개 VFS 경로는 staging을 참조하지 않는다.

완료는 조각을 검증하며 별도 최종 Blob에 스트리밍한 뒤, `withMutation`의 DB 트랜잭션에서 조건·논리 quota·Node/Blob/revision·세션 완료를 함께 확정한다. FINALIZING 작업자는 token과 lease로 fencing하며 스트리밍 동안 heartbeat를 갱신한다. DB 커밋 전 객체 생성은 비가시적이고, 커밋 실패의 미참조 객체는 삭제를 시도하거나 orphan GC에 맡긴다. GC는 활성 staging key를 보호하고 종결 조각 삭제를 재시도한다.

## 검토한 대안

- **VFS 임시 Node로 조각 노출:** 조회·snapshot·quota 경로마다 부분 파일을 숨기는 예외가 필요하다.
- **고정 staging key에 덮어쓰기:** 이전 실패의 지연된 삭제가 새 조각을 제거할 수 있다.
- **객체 저장과 DB 공개를 한 원자 작업으로 취급:** 객체 저장소와 DB 사이에 분산 트랜잭션이 없다. DB에서 최종 참조만 원자적으로 공개하고 미참조 객체를 GC로 회수한다.

## 결과

임시 객체가 삭제되기 전까지 staged quota를 소비하며 GC 실행과 orphan grace가 운영 조건이다. 완료 실패에서 미참조 최종 객체가 잠시 남을 수 있다. API 이전 버전과 가역 DB migration으로 구조적 롤백은 가능하지만 이미 공개된 파일과 진행 중 세션의 의미를 자동 역전하지는 못한다.
