# GC가 시작 뒤 일정 기간이 지난 미완료 multipart upload를 abort한다

## 상태

승인됨 (2026-10-06)

## 배경

`S3BlobStorage.put`은 `@aws-sdk/lib-storage`의 `Upload`로 multipart upload를 연다.
오류가 나면 `leavePartsOnError: false`로 SDK가 `AbortMultipartUpload`를 보낸다.
프로세스가 강제 종료되면(SIGKILL, OOM, 전원 차단, 종료 대기 초과 뒤 `closeAllConnections()`) 이 정리가 실행되지 않는다.
올라간 조각은 스토리지에 남는다.

- 미완료 upload는 완성 object가 아니다. `ListObjectsV2`에 나오지 않는다. 기존 orphan object 단계(`orphan-objects-blobs`, `orphan-objects-staging`)가 보지 못한다.
- bucket lifecycle의 `AbortIncompleteMultipartUpload` 규칙으로도 회수할 수 없다. VersityGW v1.8.0(posix)은 `PutBucketLifecycleConfiguration`에 501 `NotImplemented`를 반환한다.
- api ADR-0043은 "강제 종료로 남는 상태는 GC 1회로 복구된다"고 적었다. 완성 object는 맞고 미완료 multipart upload는 이 결정 전까지 복구되지 않았다.

실측(2026-10-06, `versity/versitygw:v1.8.0`, posix):

- `ListMultipartUploads`: 지원한다. `Initiated`를 돌려준다.
- `AbortMultipartUpload`: 지원한다. 이미 abort한 upload를 다시 abort한 결과는 통합 테스트로 확인했다.
- `KeyMarker`만 주면 다음 page가 정상 반환된다.
- `UploadIdMarker`를 주면 유효한 값이어도 `InvalidArgument: Invalid uploadId marker`다. `NextUploadIdMarker`를 그대로 넘겨도 같다.

Storix는 multipart를 `put` 한 번 안에서만 연다. 요청 사이에 열어 두지 않는다.
upload는 `STORIX_MUTATION_MAX_UPLOAD_SECONDS` 안에 끝난다(HTTP `requestTimeout`도 이 값을 따른다).

## 결정

- `BlobStorage`에 `listIncompleteUploadsPage(prefix, { after?, limit })`와 `abortIncompleteUpload(key, uploadId)`를 추가한다. S3 구현은 `ListMultipartUploads`와 `AbortMultipartUpload`다.
- GC가 단계 `incomplete-uploads-blobs`(`blobs/`)와 `incomplete-uploads-staging`(`upload-staging/`)을 `orphan-blobs` 뒤에 실행한다. Storix prefix 밖의 upload는 조회하지 않는다.
- `Initiated`가 `STORIX_MUTATION_MAX_UPLOAD_SECONDS + STORIX_ORPHAN_GRACE_PERIOD`(기본 2일)보다 오래된 upload만 abort한다.
  - 정상 upload는 최대 업로드 시간 안에 끝난다. 그 뒤 유예까지 지났으면 소유한 요청이 없다.
  - 새 환경변수는 만들지 않는다.
  - gc 서비스에 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`를 전달한다. app보다 작은 값을 gc가 쓰면 진행 중 upload를 abort할 수 있다.
- 이어 읽는 위치는 key 하나다(`KeyMarker`). 단계는 재개 위치를 두는 단계이며 `gc_cursor`에 key를 저장한다. 단위는 읽은 upload 수다.
- abort는 20개씩 병렬로 보낸다. 실패한 upload는 집계하지 않고 로그를 남긴다. 다음 실행에서 다시 후보가 된다.
- `NoSuchUpload`는 성공으로 본다. 완료되었거나 다른 GC 실행이 먼저 지운 upload는 목표 상태에 이미 도달했다.
- GC 결과에 `abortedIncompleteUploads`를 추가한다.

## 대안

- bucket lifecycle `AbortIncompleteMultipartUpload`: VersityGW가 구현하지 않는다(501). 기각.
- `UploadIdMarker`로 같은 key의 upload까지 정확히 이어 읽기: VersityGW가 거부한다. 기각.
- 종료 시 진행 중 upload를 추적해 abort: 강제 종료에서는 실행되지 않는다. 기각.
- 별도 유예 환경변수: 기존 두 값의 합으로 의미가 정해진다. 설정이 늘어난다. 기각.

## 한계

- 같은 key의 미완료 upload가 둘 이상이고 page(1000개) 경계에 걸리면 나머지는 그 실행에서 건너뛴다. Storix는 업로드마다 새 UUID key를 만들어 같은 key의 upload가 둘 이상 생기지 않는다. 건너뛴 upload는 다음 실행에서 다시 후보가 된다.
- 스토리지 계정에 `s3:ListBucketMultipartUploads`와 `s3:AbortMultipartUpload` 권한이 필요하다(`README.s3.md`의 정책 예시에 있다). 권한이 없으면 단계가 실패하고 GC 실행이 오류로 끝난다.
- AWS S3와 다른 S3 호환 백엔드는 실측하지 않았다. VersityGW(posix) 기준이다.
- `put`이 진행 중인 upload의 조각이 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`를 넘겨 계속 올라가는 경우는 없다고 본다. HTTP `requestTimeout`이 같은 값이지만 스토리지 쪽 전송은 요청 수신보다 늦게 끝날 수 있다. 유예(기본 1일)가 이 여유다.

## 결과

- 강제 종료로 남은 multipart 조각이 GC 실행으로 회수된다.
- VersityGW(posix) 통합 테스트로 목록·page 이어 읽기·abort·재abort를 확인했다.
- GC 통합 테스트(PostgreSQL, SQLite)로 오래된 upload만 abort하고 최근 upload와 Storix prefix 밖 upload는 남는 것을 확인했다.
