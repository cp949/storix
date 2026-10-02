# Namespace 관리자 삭제

## 목적과 경계

- 관리자가 namespace의 데이터 접근을 종료한다.
- live·snapshot·휴지통·재개 업로드 데이터를 GC에서 비동기로 영구 제거한다.
- 삭제 접수 재전송과 GC 재시작은 같은 데이터를 중복 정산하지 않는다.
- 최종 사용자 권한과 프로젝트 종료 판단은 호출 서버가 담당한다.
- 삭제 취소·복원, namespace tombstone의 물리 삭제와 자동 만료는 제공하지 않는다.
- secure erase, backup·replica·object versioning의 과거 버전·외부 cache 회수는 범위 밖이다.

요구사항은 [RQ-030](../requirements/file-storage.md#rq-030-namespace-관리자-삭제)이다.
결정은 api ADR-0032다.

## HTTP 계약

관리자 전용 라우트:

| 경로                                                  | 동작                            |
| ----------------------------------------------------- | ------------------------------- |
| `POST /api/v2/admin/namespaces/{namespaceId}/delete`  | 삭제 접수 또는 최초 응답 재생   |
| `GET /api/v2/admin/namespaces/{namespaceId}/deletion` | 삭제 operation의 현재 상태 조회 |

- `@Public()`과 `AdminApiKeyGuard`를 함께 적용한다.
- 서비스 key만 있거나 admin key가 설정되지 않은 배포에서는 `401 UNAUTHORIZED`다.
- 두 라우트는 DB 조회 전에 `isUuid`로 검사한다. 형식 오류는 `404 NAMESPACE_NOT_FOUND`다.
- `@Audited()`, `DomainErrorFilter`, `StructuredLoggingInterceptor`를 적용한다.
- 인증 실패는 filter의 감사 기록을 남긴다. 구조화 요청 로그는 인증 통과 뒤에 남긴다.
- 정상 응답은 `Cache-Control: no-store`다.

### 삭제 접수

- api ADR-0018의 `POST` + 동사형 경로 규칙을 따른다.
- `Idempotency-Key`는 비어 있지 않은 HTTP header 문자열이다. UUID로 제한하지 않는다.
- 키 누락·빈 문자열은 `400 IDEMPOTENCY_KEY_REQUIRED`다.
- 키가 헤더로 전송된 255 byte를 넘으면 `400 NAMESPACE_INVALID_DELETE_REQUEST`다. Node는 헤더 값을 latin1로 읽으므로 서버는 문자 수로 센다.
- 본문을 받지 않는다. `Content-Length`가 0보다 크거나 `Transfer-Encoding`이 있으면 같은 400이다.
- JSON parser 오류는 인증보다 먼저 반환될 수 있다. 잘못된 JSON은 400, 16 KiB 초과는 `413 BAD_REQUEST`다.
- 없는 namespace는 `404 NAMESPACE_NOT_FOUND`다.
- root 잠금 안에서 ACTIVE를 DELETING으로 바꾼다.
- operation·최초 응답 receipt·상태 변경을 같은 DB transaction에서 커밋한다.
- 최초 응답은 `202 Accepted`와 아래 본문이다.
- `Location`은 `/api/v2/admin/namespaces/{namespaceId}/deletion`이다.

```json
{
  "namespaceId": "7a8f5d2c-662c-4f1a-9708-b770f5928a3b",
  "status": "DELETING"
}
```

재요청 규칙:

- receipt identity는 namespace ID와 삭제 key의 SHA-256 hash다.
- 생성·quota·trash receipt와 별도 테이블을 쓴다.
- 요청 본문이 없어 fingerprint를 두지 않는다.
- 같은 namespace ID·key는 최초 HTTP status·body를 재생한다. 완료 뒤에도 최초 202는 202다.
- `Location`은 UUID로 재구성한다. receipt에 header를 저장하지 않는다.
- 같은 key를 다른 UUID에 쓸 수 있다. `422 IDEMPOTENCY_KEY_REUSED`는 이 라우트에서 발생하지 않는다.
- 다른 key로 DELETING을 삭제하면 같은 operation을 가리키는 202를 새 receipt로 저장한다.
- 다른 key로 DELETED를 삭제하면 `200 {namespaceId, status: "DELETED"}`를 저장한다.
- COMPLETED에서는 root 대신 operation 행을 잠가 새 receipt를 직렬화한다.
- 인증·입력 오류와 없는 namespace ID는 삭제 receipt를 저장하지 않는다.
- 커밋 뒤 transport 장애는 접수를 취소하지 않는다.
- 삭제 receipt와 namespace tombstone은 자동 만료하지 않는다.

### 삭제 상태 조회

- operation이 있으면 200이다.
- 없는 namespace는 `404 NAMESPACE_NOT_FOUND`다.
- ACTIVE이며 operation이 없으면 `404 NAMESPACE_DELETION_NOT_FOUND`다.
- 응답 필드는 다음과 같다.

| 필드            | 의미                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `namespaceId`   | 삭제 대상 namespace ID                                                         |
| `status`        | 현재 namespace 상태 `DELETING`·`DELETED`                                       |
| `phase`         | `UPLOADS`·`METADATA`·`OBJECTS`·`COMPLETED`                                     |
| `requestedAt`   | 접수 시각의 ISO 8601 문자열                                                    |
| `completedAt`   | 완료 전 `null`, 완료 transaction에서 기록한 ISO 8601 문자열                    |
| `blockedReason` | `null`·`UPLOAD_SETTLEMENT_UNKNOWN`·`STORAGE_DELETE_FAILED`·`DATA_INCONSISTENT` |

- 상태와 operation은 한 SELECT snapshot에서 읽는다.
- stack trace·storage key·자격증명은 응답에 포함하지 않는다.
- GET의 DB 오류는 persistence 오류 계약을 따른다.
- transient DB 장애는 작업을 미완료로 남긴다. 다음 GC에서 재시도한다.

## 접근과 이름 재사용

DELETING·DELETED에서는 다음 요청을 `404 NAMESPACE_NOT_FOUND`로 차단한다.

- 일반 VFS 읽기·쓰기, presigned 발급.
- conditional mutation·content와 완료 receipt 재생.
  - 처리 중 receipt claim이 소실되면 namespace의 ACTIVE 상태를 다시 조회한다.
  - 비활성이면 `404 NAMESPACE_NOT_FOUND`를 반환한다. 이 응답은 receipt에 저장하지 않는다.
  - ACTIVE이거나 상태 조회가 실패하면 원래 claim-lost 오류를 전파한다.
  - raw claim-lost와 오류 receipt 완료의 fencing 실패에 같은 규칙을 적용한다.
- snapshot·trash, change-feed·checkpoint, capability.
- upload session 생성·part PUT·complete·GET·DELETE와 완료 replay.
- PUBLIC content·download.
- quota·trash 관리자 변경과 기존 receipt 재생.

조회 경계:

- 관리자 삭제 상태 조회와 내부 정리는 비활성 namespace에 접근한다.
- 일반 namespace 상세 GET은 status와 정산 중 quota를 조회한다.
- 일반 namespace 목록은 ACTIVE만 반환한다.
- 삭제 접수 커밋 뒤 시작한 데이터 요청을 차단한다.
- 커밋 전에 읽기 snapshot을 확보한 요청과 전달 중인 스트림의 즉시 중단은 보장하지 않는다.
- 이미 발급한 storage presigned URL은 object 제거 또는 URL 만료까지 유효할 수 있다.

이름과 생성 receipt:

- 이름은 DELETING 전환 커밋부터 재사용한다. ACTIVE partial UNIQUE index를 유지한다.
- 같은 이름을 재생성할 때 새 생성 key와 새 namespace ID를 쓴다. 정리는 기존 ID로만 조회한다.
- 기존 생성 key는 최초 응답을 유지한다.
  - 201 receipt는 기존 namespace ID와 생성 당시 `status: "ACTIVE"`를 재생한다.
  - 409 receipt는 이름 해제 뒤에도 `409 NAMESPACE_ALREADY_EXISTS`를 재생한다.
- 현재 상태는 상세 GET으로 확인한다. 삭제 API는 생성 receipt를 고치거나 지우지 않는다.

## 영속 상태와 잠금

- `namespace_deletion`은 namespace ID별 단일 operation이다. phase·시각·blockedReason을 보존한다.
- `namespace_deletion_receipt`는 namespace ID·key hash에 UNIQUE를 둔다.
- namespace 행은 DELETED 뒤에도 정책과 ID를 tombstone으로 보존한다.
- 접수는 `NamespaceDeletionService`·`NamespaceDeletionRepository`가 담당한다.
- 정리는 `NamespaceDeletionCleanup`·`NamespaceDeletionCleanupRepository`가 담당한다.
- object 회수는 기존 `BlobStorage`와 GC를 쓴다.

root 잠금:

- root는 OBJECTS 완료까지 내부 잠금용으로 남긴다.
- 접수와 VFS 변경은 같은 root 잠금을 쓴다.
- `withMutation`과 `createChangeFeedCheckpoint`는 root 잠금 직후 ACTIVE를 재검사한다.
- 내부 정리만 명시적 `allowInactive` 옵션을 쓴다.
- 삭제가 먼저 커밋되면 대기 writer는 반영하지 않는다.
- writer가 먼저 root를 잠그면 변경을 완료한 뒤 삭제가 접수된다.
- snapshot 본문 조회는 root 잠금 안에서 storage를 연다. 삭제가 이 조회를 기다릴 수 있다.

usage 잠금:

- 접수와 완료는 root → global usage → namespace usage 순서로 잠근다.
- 접수는 usage 잠금 뒤 namespace status를 일반 UPDATE로 바꾼다.
- namespace 행에 별도 `SELECT ... FOR UPDATE`를 추가하지 않는다. FK의 key-share 잠금과 경합을 줄인다.
- upload admission은 global → namespace usage 순서를 유지한다. root를 추가로 기다리지 않는다.
- 생성·part 예약·finalize claim은 usage 잠금 안에서 ACTIVE를 재검사한다.
- finalize claim의 상태 검사는 COMPLETED·FAILED replay보다 앞선다.
- 외부 object 삭제 동안 삭제 쪽은 root·usage DB 잠금을 보유하지 않는다.

재시작과 드라이버:

- 각 배치는 root 잠금 안에서 phase와 행 존재를 재검사해 중복 정산을 막는다.
- 완료 경쟁에서 root가 없으면 COMPLETED를 확인하고 종료한다. 그 밖의 root 부재는 정합성 오류다.
- SQLite transaction gate는 프로세스 내부 직렬화다.
- API·GC 프로세스 사이는 SQLite 파일 잠금과 기존 `README.sqlite.md` 배포 전제를 따른다.
- `SQLITE_BUSY`는 persistence 오류로 처리하고 다음 GC에서 재시도한다.

## GC 단계

### GC 연결

- `GcJob.run()`은 `collectOrphanBlobs` 앞에서 UPLOADS·METADATA, 뒤에서 OBJECTS 완료 판정을 실행한다.
- 미완료 operation을 UUID keyset으로 100개씩 순회한다. 앞 namespace의 보류가 뒤 작업을 막지 않는다.
- 순회는 GC 단계 예산(`STORIX_GC_MAX_ROWS_PER_STAGE`, 단위는 읽은 operation 수)을 쓴다. 소진되면 위치를 `gc_cursor`에 저장하고 다음 실행이 이어간다(`namespace-deletion-advance`, `namespace-deletion-settle`. api ADR-0033).
- namespace별 정리 예외를 격리한다. 정합성 오류는 DATA_INCONSISTENT로 기록한다.
- 기존 GC 단계 자체의 실패는 해당 단계의 오류 처리를 따른다.
- 휴지통 보존 GC와 파일 만료 GC는 ACTIVE 후보만 선택한다.
- 정리 진행에는 배포의 GC 예약이 필요하다. 완료 시간의 상한을 보장하지 않는다.
- METADATA 단계는 namespace 하나의 live·snapshot·trash를 한 GC 실행 안에서 끝까지 제거한다. namespace 하나 안에서는 배치 수 상한이 없다.
- 큰 namespace는 같은 실행에서 뒤 namespace의 정리를 그만큼 늦춘다. 배치마다 커밋하므로 중단 뒤 재시작은 안전하다. 지연 시간은 측정하지 않았다.
- 상한을 두지 않은 이유: 실행 사이에 `STORIX_GC_MIN_INTERVAL`(기본 3600초) 간격이 있어, 상한은 큰 namespace의 완료를 실행 횟수만큼의 간격으로 늦춘다. 측정 없이 값을 정하지 않는다.

### UPLOADS

- OPEN session을 내부 terminal 전환으로 CANCELLED 처리한다.
- FINALIZING worker의 파일 반영은 root 잠금 뒤 ACTIVE 재검사로 막힌다.
- 만료된 finalize lease는 기존 GC가 OPEN으로 복구한다. 뒤 정리에서 CANCELLED로 전환한다.
- `commitPart`의 OPEN 검사가 CANCELLED session의 신규 조각 반영을 막는다.
- 이미 시작한 PUT 종료 callback과 tombstone 정리는 허용한다.
- part·tombstone은 기존 key별 lease·GC 흐름으로 정리한다.
- PUT 종료와 object 삭제 확인 전에 staged usage를 해제하지 않는다.
- OPEN·FINALIZING session이 없으면 METADATA로 간다.
- staging part·tombstone은 메타데이터 제거를 막지 않는다. 완료 조건에서 확인한다.

### METADATA

- `trashEnabled`와 관계없이 영구 제거한다. 새 휴지통 manifest는 만들지 않는다.
- change-feed state·event를 Node보다 먼저 지운다. 내부 정리는 새 feed event를 만들지 않는다.
- root 제외 live leaf를 최대 500행씩 제거한다. 사용자 `maxSyncDeleteNodes`는 적용하지 않는다.
- FILE별 Blob 참조와 live byte 합을 같은 transaction에서 차감한다.
- snapshot·trash는 manifest 한 개와 전체 entry를 한 transaction에서 제거한다.
- manifest를 분할하지 않아 `node_count > 0` CHECK와 entry 수·bytes 불변식을 유지한다.
- 같은 Blob을 가리키는 COW FILE entry도 참조를 각각 정산한다.
- `removeManifest`는 공개 snapshot·trash 삭제의 정산 규칙을 별도로 적용한다.
- SQLite bigint 정밀도를 유지하려고 counter를 `CAST(... AS TEXT)`와 BigInt로 읽는다.
- 부족한 counter·Blob 참조나 manifest 불일치는 롤백한다. 값을 0으로 덮어쓰지 않는다.
- live·snapshot·trash 제거 뒤 VFS mutation receipt를 지운다.
- terminal session은 모든 part가 DELETED이고 같은 session의 tombstone이 없을 때만 지운다.
- session 제거 조건은 usage 잠금 안에서 재확인한다.
- tombstone이 남은 session은 늦은 PUT 종료·과금 해제에 필요하므로 보존한다.
- namespace usage 행은 유지한다. `lockUsage`에 의한 재생성과 중복 차감을 피한다.
- global usage는 namespace usage와 함께 이미 갱신된다. 별도로 차감하지 않는다.
- 삭제 operation·삭제 receipt·생성 receipt·quota/trash 관리자 receipt·audit log는 보존한다.
- root 제외 live·snapshot·trash가 없으면 OBJECTS로 간다.

### OBJECTS와 완료

- 기존 orphan grace와 `reference_count = 0`·`zero_since` 규칙을 유지한다.
- object 삭제 성공 뒤 Blob row를 지운다. 실패한 row는 다음 GC에서 재시도한다.
- 매 실행 session 제거를 재시도한다. 기존 staging GC가 조각을 정리한 뒤 session을 제거할 수 있다.
- 참조 중 Blob은 DATA_INCONSISTENT다.
- grace가 지난 참조 0 Blob이 남으면 STORAGE_DELETE_FAILED다. 다음 검사에서 사라지면 해제한다.
- grace 대기 Blob은 완료를 보류한다.
- 미정착 tombstone은 UPLOAD_SETTLEMENT_UNKNOWN이다. session 대기보다 먼저 판정한다.
- staging part·tombstone의 object 삭제가 계속 실패해도 `blockedReason`은 `null`이다.
  - 기존 staging GC는 삭제 실패를 로그에 남기고 다음 실행에서 재시도한다. 실패와 대기를 구분하는 기준 시각은 없다.
  - 이 경우 operation은 OBJECTS에 머문다.
- API 프로세스 중단으로 PUT 종료를 알 수 없으면 자동 해소하지 않는다.
- counter·usage 불일치는 DATA_INCONSISTENT다.

완료 transaction에서 재확인하는 조건:

- Blob·upload session·staging tombstone·snapshot·trash가 없다.
- root를 제외한 live Node가 없다.
- live·retained snapshot·retained trash counter가 모두 0이다.
- namespace upload usage의 staged bytes·active sessions가 모두 0이다.

조건을 만족하면 root 제거·namespace DELETED·operation COMPLETED·completedAt 기록을 함께 커밋한다.
최종 참조 해제 뒤 `STORIX_ORPHAN_GRACE_PERIOD`와 다음 GC 실행을 기다린다.
PostgreSQL에는 `STORIX_GC_MIN_INTERVAL`도 적용된다.

## DELETED의 의미

- live·snapshot·trash 데이터와 upload session이 없다.
- Blob row로 추적하던 object와 과금 중 staging의 정리를 확인했다.
- 삭제 상태·receipt·namespace tombstone·생성 receipt·audit log는 남는다. tombstone·삭제 상태·삭제 receipt는 보존 기간 뒤 물리 삭제한다(아래 "보존과 물리 삭제").
- DB 반영 전 업로드한 metadata 없는 object와 늦게 끝난 raw PUT·finalize PUT은 완료 판정에서 제외한다.
- metadata 없는 object는 `collectOrphanObjects`가 storage listing과 grace를 거쳐 회수한다.
- 반영 실패 시 raw object를 즉시 지우지 않는다. 커밋 여부가 불명확한 실패에서 참조 중 object를 지우는 것을 피한다.
- backup·object versioning의 과거 버전·외부 cache의 삭제를 뜻하지 않는다.

## 보존과 물리 삭제

- `DELETED`로 끝난 namespace의 행은 영구히 두지 않는다. `namespace_deletion.completed_at`부터 `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`(기본 30일)가 지나면 GC 단계 `deleted-namespace-purge`가 물리 삭제한다. 결정은 api ADR-0035다.
- 후보는 `phase = 'COMPLETED'`이고 namespace `status = 'DELETED'`인 행이다. DELETING·보류(`blockedReason`)·정산 미확정 operation은 후보가 아니다. 후보 조회는 `idx_namespace_deletion_completed`로 한다.
- namespace마다 한 트랜잭션으로 `namespace_deletion_receipt` → `vfs_upload_usage`(0 값) → `namespace_deletion` → `namespace` 행을 지운다. 남은 참조 행이 있으면 FK 위반으로 롤백하고 그 namespace를 건너뛴다. 건너뛴 후보는 같은 실행에서 다시 읽지 않는다.
- 생성 receipt(`idempotency_key`)는 이 단계의 대상이 아니다. 자체 보존 기간(ADR-0034)을 따른다. `audit_log`는 건드리지 않는다.
- 물리 삭제 뒤:
  - `GET /api/v2/namespaces/{id}`는 404다. 보존 기간 안에서는 `status: DELETED`를 반환한다.
  - 삭제 상태 조회와 같은 key의 삭제 재요청은 404 `NAMESPACE_NOT_FOUND`다. 보존 기간 안에서는 최초 202 재생이다.
  - 같은 이름의 namespace 생성은 접수 커밋부터 가능하다. 이 점은 바뀌지 않는다.
- 운영 주의: `STORIX_VFS_CAPABILITIES_CONFIG_PATH`에 namespace ID를 적었다면 그 namespace가 물리 삭제된 뒤의 시작은 `unknown namespace ID` 오류로 거부된다. 삭제한 namespace는 설정에서 지운다.

## 배포와 복원

```text
위험도: 높음
롤백: 삭제 접수 뒤 ACTIVE 복귀를 지원하지 않는다. 데이터 제거 뒤에는 삭제 접수 이전 백업의 복원이 필요하다.
```

- 상태·receipt migration은 additive다. 물리 삭제는 되돌릴 수 없으며 복구에는 삭제 전 백업이 필요하다.
- 구버전 API는 데이터 경로의 ACTIVE 검사를 수행하지 않는다.
- 기존 single-instance 배포의 API·GC 버전을 함께 교체한다. 버전 혼합 중에는 삭제를 접수하지 않는다.
- 이미 제거된 데이터는 이미지 롤백으로 복원되지 않는다.
- DELETING 중 백업을 복원하면 status·operation도 복원된다. 다음 GC가 정리를 재개한다.
- 삭제 취소 목적의 복원에는 접수 이전 백업이 필요하다.
- tombstone이 남은 DB도 `hasExistingNamespaces` 판정 대상이다. 덮어쓰기 복원은 `STORIX_RESTORE_FORCE`가 필요하다.

## 검증 경계

- `apps/contract/src/contracts/namespace/namespace-deletion.ts`는 관리자 인증·202 재생·접근 차단·상태·이름 재사용·격리를 확인한다.
- 공개 계약은 GC 완료를 기다리지 않는다.
- `apps/api/test/namespace/namespace-deletion.http.shared-tests.ts`는 입력·receipt·HTTP와 인증·PUBLIC·upload·fs 쓰기·snapshot·trash 접근 차단을 고정한다.
- `apps/api/test/persistence/namespace-deletion.repository.shared-tests.ts`는 writer·upload admission과 삭제의 경합을 고정한다.
- `apps/api/test/jobs/namespace-deletion.cleanup.shared-tests.ts`는 정산·재시작·grace·완료 보류·실패 격리를 고정한다.
- `apps/api/test/vfs/conditional-content.namespace-deletion.sqlite.integration-spec.ts`는 삭제 GC의 receipt 제거 뒤 업로드 재개가 404이며 live 데이터를 반영하지 않음을 고정한다.
- 실제 소비자·브라우저·운영 GC 예약·운영 백업 복원은 별도 검증 대상이다.
