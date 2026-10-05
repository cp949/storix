# Namespace 변경 feed

## 목적과 경계

- `GET /api/v2/namespaces/{namespaceId}/fs/changes`는 현재 파일·디렉터리 트리를 전체 열거한 소비자가 이후 변경을 이어 받게 한다.
- 서비스 Bearer 인증과 ACTIVE namespace 확인을 적용한다.
- feed는 상태 변경 신호이며 파일 바이트 이력이나 과거 revision의 본문을 제공하지 않는다.
- 소비자는 살아 있는 파일의 현재 상태를 다시 읽는다.

비활성 namespace의 checkpoint 차단과 feed 정리는 [namespace 삭제 설계](./13-namespace-deletion.md)의 "접근과 이름 재사용"·"METADATA"를 따른다.

## Namespace 순서와 net 이벤트

- namespace별 journal state는 마지막 `sequence`, 보존 경계 `prunedThrough`, 최초 checkpoint 여부와 cursor 서명 상태를 보유한다.
- 파일 mutation, 이벤트 삽입 및 sequence 발급은 한 DB transaction에서 확정하거나 함께 롤백한다.
- PostgreSQL은 namespace root 행 잠금으로 mutation과 checkpoint를 직렬화한다.
- SQLite는 단일 프로세스 query gate를 사용한다.
- SQLite 다중 프로세스 writer는 지원 전제가 아니다.
- 전역 DB sequence는 namespace의 커밋 순서를 보장하지 않으므로 사용하지 않는다.

- 한 mutation transaction의 노드별 최초 상태와 최종 상태를 비교해 순수 변경만 `created`, `updated`, `moved`, `deleted`로 기록한다.
- 한 노드가 여러 번 바뀌어도 항목은 하나다.
- 최초 상태와 최종 상태가 같으면 기록하지 않는다.
- 이동은 같은 ID와 이전·현재 경로, 삭제 tombstone은 삭제 전 ID·종류·마지막 경로를 보존한다.
- 살아 있는 노드의 revision은 최종 상태이고 삭제에는 revision이 없다.
- 디렉터리 이동은 영향받은 descendant마다, 재귀 삭제는 삭제된 노드마다, 복사는 새 노드마다 기록한다.
- snapshot 생성·목록·삭제는 트리 변경이 아니므로 제외하며 snapshot 복원으로 파일 상태가 바뀌면 `updated`를 기록한다.

최종 상태 비교에는 디렉터리 listing revision도 포함한다. 같은 transaction에서 자식을 생성했다 삭제하면 그 자식의 이벤트는 없지만, 커밋된 revision이 바뀐 디렉터리 조상마다 최종 revision을 담은 `updated` 한 항목을 기록한다.

- 같은 transaction의 이벤트는 `operationId`를 공유하고 `operationIndex`와 `operationCount`로 묶인다.
- 항목 순서는 경로 segment와 node ID로 결정한다.
- 페이지는 transaction 중간에서 끝날 수 있다.
- 소비자는 필요하면 operation 전체를 모아 적용하고 `sequence`를 멱등 키로 사용한다.

## 최초 checkpoint와 소비자 재생

- cursor 없는 요청은 namespace mutation 직렬화 지점에서 현재 sequence를 checkpoint로 발급하고 빈 `changes`와 `nextCursor`를 반환한다.
- 최초 checkpoint 이전의 상태는 기존 `ls` 전체 열거로 수집한다.

소비자는 다음 순서로 동기화한다:

1. checkpoint를 저장한다.
2. 전체 트리를 열거한다.
3. checkpoint 이후 이벤트를 재생한다.

열거 중 `ls` cursor가 변경으로 무효화되면 같은 checkpoint를 보존하고 전체 열거만 다시 시작한다. checkpoint 이후 mutation은 journal에 남으므로 열거와 재생 사이의 변경을 복구할 수 있다.

- cursor 조회는 그 sequence를 제외하고 이후 이벤트를 오름차순으로 반환한다.
- 기본 limit는 100, 최대는 1000이다.
- `nextCursor`는 반환된 마지막 sequence를 가리키며, 빈 페이지에서는 입력 cursor를 유지해 polling에 쓴다.
- `hasMore`는 조회 시점에 다음 페이지가 있는지 나타낸다.
- 응답을 잃고 같은 cursor를 다시 조회하면 같은 sequence prefix를 다시 받을 수 있고 그 사이 새 commit이 붙을 수 있다.
- 소비자는 페이지의 변경 적용과 `nextCursor` 저장을 자신의 DB transaction에서 묶고 `sequence`로 중복을 제거한다.

## Cursor, capability와 보존

- cursor는 namespace ID와 sequence에 묶인 버전 있는 불투명 문자열이다.
- namespace별 feed state의 무작위 서명 상태로 HMAC-SHA256 인증하며, 서명 비밀은 API 응답·로그·문서 예시에 공개하지 않는다.
- 서비스 API key는 인증에만 쓰이고 cursor 서명에 쓰이지 않으므로 API key 교체는 기존 cursor를 무효화하지 않는다.
- 잘못되거나 다른 namespace의 cursor는 400 `VFS_INVALID_CURSOR`다.

- `change-feed`는 시작 설정의 기본 비활성 선택 capability다.
- 전역 및 namespace 허용과 discovery는 기존 capability 계약을 따른다.
- 비활성 endpoint는 409 `VFS_FEATURE_DISABLED`를 반환하고 일반 파일 API는 계속 동작한다.
- 첫 checkpoint 전에는 journal을 쓰지 않는다.
- 한 번 checkpoint된 namespace는 capability를 끄더라도 journal 기록을 계속해 재활성화 후 보존 기간 안의 cursor에 공백이 생기지 않게 한다.

- `STORIX_VFS_CHANGE_RETENTION_DAYS` 기본값은 30일이다.
- GC는 DB 시각으로 cutoff를 계산해 오래된 연속 이벤트를 배치 삭제하고 같은 transaction에서 `prunedThrough`를 전진시킨다.
- GC가 늦게 실행되면 30일보다 오래 보존될 수 있다.

정리 후보 순회는 `VfsChangeFeedRetentionRepository.pruneNext`가 수행한다.

- `idx_vfs_change_event_occurred_at`의 `(occurred_at, namespace_id, sequence)` 순서로 만료 이벤트를 읽는다.
- 한 호출은 cursor 뒤의 만료 이벤트 최대 500행을 읽는다.
- 읽은 이벤트가 namespace의 가장 작은 sequence(선두)이면 해당 namespace를 정리한다.
- 만료된 연속 prefix를 namespace 단위 transaction으로 최대 500개 삭제한다.
- 선두가 유효한 namespace의 만료 이벤트는 삭제하지 않고 건너뛴다.
- namespace 단위 잠금은 PostgreSQL `FOR UPDATE SKIP LOCKED`이며 잠긴 후보는 건너뛴다.
- prefix가 500개보다 길면 그 namespace의 위치에서 멈추고 다음 호출이 이어간다.
- 경계 불변식 위반 같은 예상 밖 오류가 나면 그 namespace의 transaction만 롤백하고 다음 후보로 넘어간다.
- 실패한 namespace는 `error` 로그(namespace ID·원인)를 남기고 GC 결과의 `failedChangeFeedNamespaces`에 집계한다. GC는 실패로 끝나지 않는다.
- 실패한 namespace는 다음 실행에서 다시 후보가 된다.
- PostgreSQL의 `occurred_at`은 transaction 시작 시각이라 sequence 순서와 어긋날 수 있다. 이때 뒤 sequence의 삭제는 앞 sequence가 만료될 때까지 늦어진다. 늦어지는 시간은 두 transaction의 시작 시각 차이 이하다.
- 비용은 전체 namespace 수가 아니라 읽은 만료 이벤트 수에 비례한다.

- GC 실행은 단계 예산(`STORIX_GC_MAX_ROWS_PER_STAGE`, 기본 200000, 읽은 만료 이벤트 수)을 쓴다.
- 예산이 소진되면 위치를 `gc_cursor`(`change-feed-prune`)에 저장하고 다음 실행이 거기서 이어간다.
- 끝까지 훑으면 위치를 지워 다음 실행이 처음부터 훑는다.
- 위치보다 앞에서 뒤늦게 만료된 이벤트는 그 다음 실행에서 처리한다.
- 결과의 `budgetExhaustedStages`가 예산이 소진된 단계를 알린다.
- cursor sequence가 `prunedThrough`보다 작으면 410 `VFS_CHANGE_CURSOR_EXPIRED`다.
- 경계와 같은 sequence는 유효하다.
- 만료된 소비자는 cursor를 버리고 새 checkpoint와 전체 열거로 재동기화한다.

- 페이지 조회는 state와 이벤트를 한 읽기 snapshot에서 확인한다.
- PostgreSQL은 `REPEATABLE READ`, SQLite는 query gate를 점유하는 transaction을 사용한다.
- 따라서 GC가 페이지의 두 조회 사이에 보존 경계를 올려도 삭제된 항목을 건너뛴 200 응답을 만들지 않는다.
- namespace 삭제 시 feed state와 이벤트도 제거한다.
- 마이그레이션 rollback은 journal과 cursor를 잃지만 기존 파일 트리는 보존한다.
- 재활성화 뒤 소비자는 전체 재동기화해야 한다.

## 검증 범위

- `apps/api/test/vfs/change-feed.integration-spec.ts`와 `change-feed.sqlite.integration-spec.ts`: 공개 feed API.
- `apps/api/test/persistence/vfs-change-feed.repository.shared-tests.ts`: 순차 변경·net 이벤트·rollback·페이지 재생.
- 같은 공유 spec의 barrier 테스트: 최초 checkpoint와 mutation의 직렬화, 같은 namespace의 실행·sequence 순서, namespace별 sequence 독립성.
- `apps/api/test/persistence/vfs-change-feed-gc.shared-tests.ts`: 보존 정리·GC/page 경합·namespace 삭제.
- capability 전환은 공개 feed API spec에서 확인한다.
- 운영 활성화, 특정 소비자 동기화와 production 장애 복구는 별도 검증 대상이다.
