# vfs_node.version을 bigint로 넓힌다

## 상태

승인됨 (2026-10-05)

## 배경

PostgreSQL `vfs_node.version`은 `integer`(int4)였고 코드 상수 `MAX_VFS_VERSION`은 2147483647이었다(GitHub 이슈 #41).

- 모든 mutation은 조상을 root까지 `markAncestorChain`으로 표시하고 `bumpAndReadChangedNodes`가 version을 1 올린다.
- 그래서 root가 가장 먼저 상한에 닿는다. 닿은 뒤에는 그 namespace의 모든 쓰기가 409 `VFS_REVISION_EXHAUSTED`다. 트랜잭션은 롤백된다.
- 초당 100회 mutation이면 2147483647 ÷ 100 ÷ 86400 ≈ 248일이다(산술 값, 실제 부하는 측정하지 않았다).
- root revision은 snapshot `sourceRevision` 원자 캡처, `ls /`의 `consistency=revision`, root 대상 `X-If-Revision`에 쓰인다. root bump를 없앨 수 없다.
- revision 토큰은 이미 version을 8바이트(`writeBigUInt64BE`)로 인코딩한다. 토큰 형식은 큰 값을 담을 수 있다.
- SQLite `integer`는 64비트다. SQLite에서는 코드 상수만 상한을 걸었다.

## 결정

- PG `vfs_node.version`을 `bigint`로 바꾼다. 마이그레이션은 `WidenVfsNodeVersion1791700000023`이다. SQLite는 건너뛴다.
- `MAX_VFS_VERSION`을 `Number.MAX_SAFE_INTEGER`(2^53−1)로 올린다. version을 JS number로 다루므로 정밀도가 보장되는 최댓값을 쓴다.
- `VfsNodeEntity.version`에 `transformer`(`from: Number`)를 둔다. PG `bigint`는 `pg` 드라이버가 문자열로 돌려주기 때문이다.
- raw SQL로 version을 읽는 곳(`captureSnapshotRows`, `findRecursive`)은 `Number()`로 정규화한다. `transformer`는 raw 결과에 적용되지 않는다(TRP-011).
- revision 토큰 형식은 바꾸지 않는다. 이미 발급된 토큰은 그대로 유효하다. `decodeRevision`의 상한만 2^53−1로 올라간다.
- 오류 코드 `VFS_REVISION_EXHAUSTED`는 유지한다. 2^53−1에 닿으면 이전처럼 409다. 초당 100회 mutation이어도 약 280만 년 분량이라 도달하지 않는다(산술 값).

## 대안

- 현행 상한을 두고 문서화와 수동 복구 절차만 안내: 도달 시 namespace가 영구 정지하고 복구가 운영자에게 넘어간다. 기각.
- 상한 도달 시 root version을 되감기: revision이 재사용되어 이전 토큰이 다시 유효해진다. `X-If-Revision`·`sourceRevision`의 412 의미가 깨진다. 기각.
- root bump 제거: 위 root revision 용도가 깨진다. 기각.
- `pg` 드라이버의 int8 파서를 number로 바꾸기: `blob.size`·byte count 등 기존 `bigint` 컬럼의 문자열 계약(2^53 초과 가능)이 깨진다. 기각.
- `version` 엔티티 타입을 string으로 바꾸기: version을 비교·연산하는 호출부 전체를 고쳐야 한다. 기각.
- `version_big` 컬럼 추가 → 백필 → 교체의 무중단 절차: 마이그레이션 3개와 이중 쓰기 코드가 필요하다. 현재 운영 규모 근거가 없어 기각.

## 한계

- PG 마이그레이션은 `vfs_node` 테이블을 재작성하고 `ACCESS EXCLUSIVE` 락을 잡는다. 락 시간은 행 수에 비례한다. 측정하지 않았다. 대형 테이블은 점검 창에서 적용한다.
- `down`은 `TYPE integer`다. 2147483647을 넘는 version이 있으면 `22003`으로 실패하고 값을 자르지 않는다.
- 쓰기가 계속 들어오는 디렉터리의 `consistency=revision` 열거가 412로 반복되는 문제(하위 변경이 조상 listing revision을 올림)는 이 결정으로 해소되지 않는다. 별도 설계 문제다.

## 결과

- root version이 2147483647을 넘어도 mutation·`ls`·`find`·snapshot 캡처가 동작한다. PostgreSQL과 SQLite 통합 테스트로 확인했다(version 3,000,000,000).
- 상한 테스트는 `MAX_VFS_VERSION`을 기준으로 바뀌었다.
