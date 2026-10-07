# GC가 소유권과 종료 확인을 기준으로 미완료 multipart upload를 abort한다

## 상태

승인됨 (2026-10-06, 2026-10-07 보완)

## 배경

`S3BlobStorage.put`은 `@aws-sdk/lib-storage`의 `Upload`로 multipart upload를 연다.
프로세스가 강제 종료되면 SDK의 abort 정리가 실행되지 않을 수 있다.
남은 upload는 완성 object가 아니므로 `ListObjectsV2` 기반 orphan 정리에서 보이지 않는다.

VersityGW v1.8.0 posix에서 `ListMultipartUploads`와 `AbortMultipartUpload`를 실측했다.
같은 gateway에서 `UploadIdMarker`는 유효한 값도 `InvalidArgument`로 거부했다.
`KeyMarker` 이어 읽기는 지원했다.
또한 진행 중인 complete가 multipart 목록에서 빠진 뒤 abort에 `NoSuchUpload`를 반환하고, worker가 나중에 object를 공개한 사례가 있다.

업로드 요청의 deadline과 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`는 전체 storage worker 종료 시각의 상한이 아니다.
heartbeat나 업무 lease 만료도 storage PUT Promise의 정착을 증명하지 않는다.

## 결정

- 공통 온라인 `BlobStorage.put` 래퍼가 storage 호출 전에 durable PUT 시도 기록을 확정한다.
- 기록 확정이 실패하면 storage PUT를 시작하지 않는다.
- 기록에는 key, 시도 식별자, 프로세스 실행 식별자, 정착 상태를 저장한다.
- PUT Promise가 성공하거나 실패로 정착한 뒤 시도 상태를 `SETTLED`로 기록한다.
- 정착 기록 저장이 실패하면 재시도하고 오류를 로그로 남긴다.
- 시도 기록과 process 종료 확인 기록은 자동 삭제하지 않는다.
- 소유권 테이블에 없는 multipart key는 owner unknown으로 보고 abort를 보류한다.
- owner 조회 오류도 abort를 보류하고 원인을 로그로 남긴다.
- owner가 `SETTLED`이거나 해당 실행의 종료 확인이 있어야 GC 회수 claim을 받을 수 있다.
- PUT 등록과 GC claim은 key별 같은 DB 행을 잠가 원자적으로 배제한다.
- claim을 얻은 동안 새 PUT를 시작하지 않는다.
- GC 프로세스가 종료돼 claim이 남으면 해당 GC 실행의 종료 확인 뒤에만 claim을 넘겨받는다.
- multipart의 age cutoff는 후보를 줄이는 조건으로만 쓴다. worker 종료 증거로 쓰지 않는다.
- `abort` 성공, `NoSuchUpload`, multipart 목록 부재는 resumable staging 예약량 해제 근거가 아니다.
- SQLite는 단일 writer 전제를 따른다. PostgreSQL은 여러 API와 독립 GC의 key claim 경합을 지원한다.
- `confirm-stopped` 운영 CLI는 관리자가 실제 writer 실행 종료를 외부에서 확인한 실행 식별자를 기록한다.
- 종료 확인 시각과 최초 확인 근거를 DB에 보존한다. gateway worker 종료 확인으로 해석하지 않는다.
- CLI 확인은 자동 감지가 아니라 관리자 attestation이다.
- 실행 식별자는 API·GC 시작 로그에 출력한다. 공개 HTTP API는 추가하지 않는다.
- backup은 owner 기록을 DB dump에 보존한다. restore는 API·GC 중단 전제를 유지한다.
- 복원된 이전 실행은 자동 종료 확인하지 않는다.
- restore가 기록을 복원하지 못했거나 이전 배포가 owner 기록을 만들지 않은 multipart는 별도 유지보수 절차로만 회수한다.
- legacy 유지보수는 전체 writer와 GC를 중단한 뒤 `key + uploadId` manifest를 출력한다.
- 운영자는 manifest 목록과 SHA-256을 확인하고 같은 manifest만 abort한다.
- legacy 회수는 staging 예약량을 변경하지 않는다.

## 배포 전환

- schema migration을 적용하기 전에 기존 API writer와 GC를 모두 중단한다.
- 부모 `pnpm` 종료만으로 자식 writer `node` 종료를 판정하지 않는다.
- 새 API·GC를 시작한 뒤 시작 로그의 실행 식별자를 보존한다.
- migration 전 multipart는 owner unknown이므로 자동 GC가 회수하지 않는다.
- legacy upload 회수는 전체 writer·GC가 중단된 유지보수 절차로 수행한다.

## 한계

- 관리자가 실제 writer 실행 종료를 잘못 확인하면 활성 upload를 보호하지 못할 수 있다.
- owner unknown 및 종료 확인되지 않은 multipart는 저장 공간 회수가 지연된다.
- process 종료만으로 gateway worker 종료를 증명하지 않는다.
- 기록 테이블은 자동 정리하지 않아 행이 계속 증가한다.
- 실측은 VersityGW v1.8.0 posix 단일 gateway 기준이다. NAS, 다중 gateway, AWS 실제 API 동작을 보장하지 않는다.

## 검증

- `test/persistence/storage-put-ownership.integration-spec.ts`는 PostgreSQL 상태 전이와 동시 PUT 등록·GC claim 경쟁을 검증한다.
- `test/persistence/storage-put-ownership.sqlite.integration-spec.ts`는 SQLite 상태 전이를 검증한다.
- `test/jobs/gc.job.shared-tests.ts`는 VersityGW 기반 오래된 upload의 소유자 종료 확인 회수와 활성 소유자 보류를 검증한다.
