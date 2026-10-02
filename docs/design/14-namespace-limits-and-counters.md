# Namespace 제한과 설정

## Namespace ID와 이름

Namespace ID는 기존 소문자 UUID 또는 `{prefix}_{UUID v4의 하이픈 제거 32자리}`다. Prefix는 `[a-z][a-z0-9_-]{0,11}`이며 전체 길이는 최대 45자다. 생성은 애플리케이션에서 수행한다. `name`은 nullable한 재사용 slug이며 ID를 대신하지 않는다.

## 상한 해석

전역 설정은 프로세스 시작 시 읽는다. 각 제한은 default와 hard ceiling으로 구성된다. Namespace override는 nullable이며 `null`은 default 상속이다. 유효값은 override가 있으면 override와 ceiling 중 작은 값이고, 없으면 default와 ceiling 중 작은 값이다.

| 제한                   | default 환경 변수                     | ceiling 환경 변수                | 기본값  |
| ---------------------- | ------------------------------------- | -------------------------------- | ------- |
| 논리 quota             | `STORIX_DEFAULT_TOTAL_LOGICAL_BYTES`  | `STORIX_MAX_TOTAL_LOGICAL_BYTES` | 50 GiB  |
| FILE 크기              | `STORIX_DEFAULT_FILE_SIZE_BYTES`      | `STORIX_MAX_FILE_SIZE_BYTES`     | 5 GiB   |
| 폴더 직접 자식 FILE 수 | `STORIX_DEFAULT_MAX_FILES_PER_FOLDER` | `STORIX_MAX_FILES_PER_FOLDER`    | 10000   |
| root 제외 live node 수 | `STORIX_DEFAULT_MAX_LIVE_NODES`       | `STORIX_MAX_LIVE_NODES`          | 1000000 |

Override는 양수 64-bit decimal string이고 ceiling 이하여야 한다. quota와 파일 크기에서 ceiling 생략 시 기존 전역 상한을 유지한다. Trash retained byte cap의 namespace 기본 유효값은 namespace quota이며 전역 quota ceiling을 넘지 않는다.

## Counter와 검사

`vfs_node.child_file_count`는 부모별 직접 자식 FILE 수다. `namespace.live_node_count`는 root를 제외한 live FILE·DIRECTORY 수다. 두 counter는 migration backfill 뒤 모든 공개 mutation과 GC 정산 경로에서 같은 transaction으로 유지한다. 제한 판정은 counter와 변경 delta로 한다. 운영 요청에서 `COUNT`나 전체 namespace scan을 수행하지 않는다.

Counter invariant는 저장된 숫자와 대응하는 실제 행 수가 일치하는 것이다. 실패한 mutation은 node·Blob 참조·quota·revision·change feed와 함께 counter 변경을 rollback한다. 삭제 GC는 배치 정산을 재시작해도 중복 차감하지 않는다.

## Quota 구성요소

논리 quota 구성요소는 live FILE, retained trash FILE, retained snapshot FILE bytes다. `quota.usedBytes`는 세 구성요소의 총합이다. `excludeTrashFromQuota`와 `excludeSnapshotsFromQuota`는 검사 대상에서 해당 구성요소를 제외한다. `quota.enforcedBytes`는 적용 제외 후 검사 대상 합계다. 조회와 mutation 검사는 동일한 플래그를 사용한다.

Restore와 기타 복합 mutation은 `liveFileByteDelta`, `trashByteDelta`, `snapshotByteDelta`별로 quota를 판정한다. 전체 합계 delta만 비교하면 구성요소 사이 이동에서 제외 정책을 우회할 수 있다. 기존 초과 상태에서는 검사 대상 사용량을 늘리는 양의 delta를 거부하고 감소 delta를 허용한다.

휴지통 보존은 namespace quota와 별도로 retained trash bytes 상한을 적용한다. 상한을 낮춰 현재 보존량보다 작게 설정해도 기존 항목을 지우지 않는다. 기존 항목의 복구·purge는 계속 허용한다.

## 설정 API

`PATCH /api/v2/admin/namespaces/{namespaceId}/settings`는 관리자 전용이다. body에는 지원 설정 중 하나 이상만 넣는다. 숫자 설정은 양수 decimal string 또는 `null`; boolean 설정은 `boolean`이다. 알 수 없는 필드와 빈 body는 400이다.

설정 변경은 namespace root mutation lock 안에서 ACTIVE를 재검사한다. 부분 설정 저장과 성공 receipt를 한 transaction에서 처리한다. Idempotency-Key는 namespace·route scope로 hash해 저장하며 canonical request hash가 같으면 최초 Namespace 응답을 재생한다. 다른 요청의 같은 key는 422다. 성공 receipt 보존은 30일이다.

## Migration과 운영

새 counter는 기존 데이터에서 backfill한다. PostgreSQL 변경은 namespace 참조 컬럼 형식 변경과 FK 재생성 순서를 보장한다. 대규모 backfill과 인덱스 변경의 시간·잠금·WAL은 배포 전 같은 규모의 namespace-scale workload로 측정한다.

폴더 FILE counter backfill은 `(parent_id, type)` 임시 인덱스를 만들어 correlated count의 parent lookup에 사용한 뒤 제거한다. 기존 `(namespace_id, parent_id, name)` 인덱스는 전체 migration의 parent-only lookup에 맞지 않는다.
부모별 counter migration의 재발 방지 규칙은 [TRP-003](../traps/TRP-003-counter-backfill-needs-parent-index.md)에 기록한다.

운영 업그레이드는 쓰기를 중단하고 백업을 확인한 뒤 별도 migration job을 실행한다. 실패하면 기존 코드와 사전 migration 백업으로 복구한다. migration down은 새 형식 ID가 남아 있거나 새 설정 데이터에 의존하는 경우 먼저 역변환·보존이 필요하다.
