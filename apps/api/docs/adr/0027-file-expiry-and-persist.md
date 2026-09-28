# 파일 만료는 FILE node에 기록하고 조건부 확정으로 해제한다

파일 생성 뒤 호출자가 그 파일을 사용하지 않으면 Storix가 고아 파일을 회수해야 한다. Blob은 여러 경로와 snapshot이 공유할 수 있으므로 객체 저장소의 lifecycle만으로 VFS FILE의 사용 여부를 판단할 수 없다.

## 결정

1. 만료는 새 FILE을 만드는 조건부 업로드, 재개 업로드, 조건부 copy에서만 지정한다. 기존 FILE에 설정하거나 연장하지 않는다. 입력을 생략한 새 FILE은 원본과 관계없이 만료가 없다.
2. `expires_at`은 삭제 가능 시각이다. 시각이 지나도 GC가 삭제하기 전까지 FILE을 조회하고 확정할 수 있다.
3. 만료는 FILE node의 속성이다. DIRECTORY에는 설정하지 않으며, 인증 API의 다른 파일 연산은 만료 예정 FILE에도 적용된다.
4. GC 삭제는 namespace의 `trash_enabled` 정책을 따른다. 휴지통 ON이면 30일 복구할 수 있고 기본값 OFF이면 즉시 영구 삭제한다.
5. PUBLIC namespace의 인증 없는 `content`와 `download`는 만료 예정 FILE을 없는 파일과 같은 404로 숨긴다.
6. capability 없이 항상 활성화한다.
7. `persist`가 만료를 해제하면 관찰 가능한 상태가 바뀌므로 version과 revision을 한 번 올린다. 이미 만료가 없으면 변경하지 않는다.

만료 입력은 `STORIX_VFS_EXPIRY_MIN_SECONDS`(기본 60)와 `STORIX_VFS_EXPIRY_MAX_SECONDS`(기본 2592000) 사이의 정수 초다. 최대 설정값은 PostgreSQL INTEGER 상한인 2147483647초다. 만료 시각은 생성 또는 완료 커밋의 DB 시각을 기준으로 계산한다. 확정은 기존 조건부 mutation의 receipt와 revision 선행 조건을 사용한다.

## 검토한 대안

- **`/.tmp` 디렉터리에 만들고 `mv`로 확정:** 확정 때 경로가 바뀌고 호출자가 경로를 갱신해야 한다. ID 기반 조회 API도 없다.
- **별도 `vfs_node_expiry` 테이블:** 조회와 공개 읽기에 join이 필요하고 cascade와 정합성을 추가로 관리해야 한다. node 상태를 직접 나타내는 속성에 맞지 않는다.
- **전용 `POST /fs/persist` endpoint:** receipt 저장·재생과 조건부 오류 처리 경로를 다시 만들어야 한다.
- **capability로 게이팅:** 항상 활성화한다는 제품 결정을 따른다.
- **시각이 되면 즉시 논리 삭제:** 모든 읽기와 쓰기 경로가 만료 시각을 검사해야 한다. GC가 실행되기 전까지 접근 가능한 수명 계약을 선택했다.
- **만료 삭제에서 항상 휴지통 우회:** 휴지통 ON namespace가 확정 누락을 복구할 수 없게 된다.

## 결과

확정 누락은 파일 삭제로 이어진다. 30일 복구는 휴지통 ON namespace에만 적용되고 `trash_enabled`의 기본값은 OFF다. 실제 삭제 시점은 GC 실행 주기에 의존하며 GC를 실행하지 않으면 만료 삭제도 일어나지 않는다.

`VfsNode.expiresAt` 필수 필드 추가는 응답 확장이며 ADR-0020의 v2 호환 범위 안이다. 기존 receipt를 재생한 응답에는 `expiresAt`이 없을 수 있다.

Migration `down`은 만료 컬럼과 인덱스를 제거한다. 이때 남은 미확정 파일은 만료 없는 영구 파일이 된다.
