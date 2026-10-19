# 압축 FILE 해제

## 공개 계약

`POST /api/v2/namespaces/{namespaceId}/fs/extract`는 같은 namespace에 이미 저장된 압축 FILE을 대상 DIRECTORY에 푼다.

- 지원 형식은 zip(STORED·DEFLATE, ZIP32), tar(ustar·PAX·GNU longname), tar.gz다.
- 형식은 확장자나 MIME이 아니라 source 앞 byte로 판별한다.
- 업로드와 동시에 풀지 않는다.
- 외부 압축 라이브러리를 쓰지 않는다. 결정은 api ADR-0049다.
- `Idempotency-Key`와 `X-Mutation-Scope`는 필수다.
- 기본 capability는 비활성이다. capability 설정 파일의 전역 허용과 namespace 허용이 모두 필요하다.

요청 본문은 JSON이며 최대 64 KiB다.

| 필드                  | 형식                                | 설명                                                                         |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `source`              | 절대 경로                           | 압축 FILE이다. 필수다.                                                       |
| `sourceRevision`      | revision 문자열                     | 필수다. 불일치는 412다.                                                      |
| `destination`         | 절대 경로                           | 풀 대상 DIRECTORY다. 필수다. 부모 사슬은 있어야 하고 자신은 없으면 만든다.   |
| `mode`                | `overwrite` \| `clean`              | 필수다.                                                                      |
| `destinationRevision` | revision 문자열                     | 선택이다. capture와 최종 커밋에서 대상 DIRECTORY의 revision을 검사한다.      |
| `exclude`             | 문자열 배열, 최대 64개, 각 1–1024자 | 선택이다. glob이다.                                                          |
| `mimeTypes`           | 객체, 최대 256개                    | 선택이다. 확장자(`.html`)에서 MIME으로 가는 map이다.                         |
| `dryRun`              | boolean                             | 선택이며 기본 false다. true면 대상을 바꾸지 않고 선택 entry 목록을 돌려준다. |

- 허용하지 않은 키, root `source`·`destination`, 잘못된 mode·boolean은 400 `VFS_INVALID_EXTRACT_REQUEST`다.
- 경로·MIME helper의 오류도 같은 코드로 바꾼다.
- 문자열 revision의 형식 오류는 400 `VFS_INVALID_REVISION`이다.
- 구조 오류가 revision 형식 오류보다 먼저 보고된다.
- `source`가 `destination` 아래에 있어도 허용한다. 선택 entry를 트랜잭션 전에 모두 읽고 검증하기 때문이다.
- `mimeTypes`의 키는 `/^\.[a-z0-9]{1,32}$/`이고 값은 엄격한 MIME이다.
- 서버는 확장자로 MIME을 추론하지 않는다. map에 없는 확장자, 확장자 없는 이름, 점으로 시작하는 이름(`.env`)은 `application/octet-stream`이다.
- 확장자 비교는 소문자로 한다. `a.HTML`에도 `.html`이 적용된다.
- DIRECTORY는 MIME map을 쓰지 않는다.

### mode

- `overwrite`는 같은 경로 FILE의 node id를 유지하고 Blob만 바꾼다. archive에 없는 FILE은 남긴다.
- `clean`은 `destination` subtree를 먼저 지운 뒤 만든다. `source`가 그 안에 있으면 함께 지워진다.
- 두 모드 모두 DB 한 트랜잭션이다. 중간 실패는 대상을 바꾸지 않는다.
- `destinationRevision`을 생략하면 커밋 시점의 대상에 mode를 적용한다. 암묵적인 snapshot 조건을 두지 않는다.
- `sourceRevision`은 capture 시점의 원본 선택 조건이다. 커밋에서 다시 검사하지 않는다.

위험은 높다. `clean`은 기존 subtree와 그 안의 `source`를 지운다.

- 휴지통이 켜진 namespace는 응답의 `trashId`로 복구한다.
- 꺼져 있으면 별도 snapshot이나 백업이 없는 한 복구할 수 없다.
- 트랜잭션 실패는 전체 rollback한다.

### entry 이름

이름 검증은 archive 이름 규칙(`validateArchiveEntryName`)을 재사용한다.

- NFC UTF-8 상대 경로다. NFD는 NFC로 바꾸지 않고 거부한다.
- 전체 4095 byte, segment 255 byte 이하다.
- `destination`을 합친 절대 경로도 4096 byte 이하다.
- 제어·Bidi 문자, 빈 segment, `.`, `..`, 선행 `/`, `\`, drive prefix를 거부한다.
- 같은 경로의 entry 중복을 거부한다. FILE과 다른 entry의 조상 디렉터리가 같은 경로이면 입력 순서와 무관하게 거부한다.
- tar·tar.gz의 선행 `./`는 벗긴다. tar·tar.gz의 DIRECTORY `./`는 건너뛴다. ZIP에는 이 예외가 없다.
- DIRECTORY 표시의 끝 `/`는 한 개만 벗긴다. 그 밖의 빈 이름, `.`, `/`는 거부한다.
- 이름이 `/`로 끝나거나 tar typeflag가 `5`인 entry는 빈 DIRECTORY를 만든다.
- 암시적으로 만든 조상 뒤의 명시적 DIRECTORY entry는 허용한다. 같은 명시적 entry의 중복은 거부한다.

거부하는 entry는 다음과 같다.

- tar의 hard link, symlink, 문자·블록 장치, FIFO, GNU sparse(`S`와 PAX `GNU.sparse.*`·`SCHILY.realsize`), contiguous file.
- ZIP의 external attribute가 symlink(unix mode `0120000`)인 entry.
- tar의 V7 헤더(ustar magic 없음). 이는 형식 오류다.

### tar 해석

- PAX `x`·`g`의 `path`와 `size`를 처리한다. `g`는 뒤 entry 전체에, `x`는 다음 entry 하나에 적용한다.
- GNU longname(`L`)을 처리한다. PAX·longname 헤더 본문은 각각 64 KiB 이하다.
- PAX 레코드 길이는 UTF-8 byte 기준이다. UTF-8이 잘못된 이름·레코드는 대체하지 않고 거부한다.
- 끝 블록 두 개와 그 뒤 zero padding을 검사한다. 끝 표시 뒤 nonzero 데이터와 끝 블록 누락은 거부한다.
- 빈 tar(zero 블록만)도 유효하다.
- GNU tar가 sparse PAX의 실제 경로를 `GNU.sparse.name`에 두므로 오류 이름에 그 값을 쓴다.

### zip 해석

- 끝 최대 65557 byte를 읽어 EOCD를 찾는다. comment 안의 가짜 signature는 comment 길이가 끝 위치와 맞지 않아 걸러진다.
- disk 번호, 두 entry 수, central directory의 offset·크기·record 합이 서로 맞아야 한다.
- central directory는 64 KiB 창으로 record를 순차로 읽는다. 전체를 메모리에 올리지 않는다.
- local header와 central directory의 이름·method·flags를 대조한다. 이 검증은 DIRECTORY와 제외 entry에도 한다.
- bit 3이 없으면 local의 CRC·크기도 central과 같아야 한다.
- bit 3이면 local의 0 placeholder를 허용하고 본문 뒤 ZIP32 data descriptor를 대조한다. signature 유무를 모두 지원한다.
- 본문은 range read, inflateRaw(DEFLATE), CRC-32와 평문 길이 검증 순으로 연결한다.
- DIRECTORY는 평문 크기가 0이면 된다. 일부 도구가 빈 DEFLATE stream으로 저장하기 때문이다.
- zip64, 암호화(flags bit 0·6·13), multi-disk, STORED·DEFLATE 외 method는 형식 오류다.
- 0-byte FILE은 역전된 range GET을 만들지 않는다.

### exclude

- 문법은 `*`(한 segment 안), `**`(완전한 segment이며 0개 이상 segment), 리터럴뿐이다. `.`, `[`, `?`는 리터럴이다.
- `a**b`, `***`, 빈 segment(`/a`, `a//b`, `a/`)는 400이다.
- 이름·종류·header 검증을 마친 상대 이름에 맞춘다. 위험한 이름이나 link를 제외 패턴으로 숨길 수 없다.
- 이름의 앞부분(조상)이 패턴을 소비하면 맞는 것으로 본다. DIRECTORY entry가 없어도 조상 패턴이 적용된다.
- 예: `__MACOSX/**`는 `__MACOSX`와 자손을, `**/.DS_Store`는 root와 깊은 경로를, `a/*.log`는 `a`의 직계만, `node_modules`는 root의 해당 subtree만 맞춘다.
- 정규식을 쓰지 않는다. 반복 `**`와 다중 `*`에서 backtracking이 없다.
- 맞는 entry는 선택 entry 수, 생성·교체 수, 응답 목록, `entryIndex`에서 뺀다.
- 처리 비용 한도는 별도다. FILE 해제 합과 gzip 압축비에는 제외한 entry도 포함한다.

### 응답

- 본 실행은 커밋 직전에 대상이 없었으면 201, 있었으면 200이다. `clean`으로 지우고 다시 만들어도 200이다.
- 본문은 `resource`, `affectedRevisions`, `entryCount`, `createdCount`, `replacedCount`, `trashId`다.
- `resource`는 destination DIRECTORY의 공통 `VfsNodeResponseDto`다. 최종 `version`과 `updatedAt`을 담고 `revision` 필드는 없다. revision은 `affectedRevisions`에서 확인한다.
- `entryCount`는 선택한 FILE과 명시적 DIRECTORY 수다. 암시적 부모는 세지 않는다.
- `createdCount`와 `replacedCount`는 FILE만 센다.
- `trashId`는 `clean`이 휴지통이 켜진 namespace의 기존 대상을 지웠을 때만 있다.
- 완료 receipt를 재생하면 최초 status·body·`X-Request-Id`를 돌려준다.
- `dryRun` 성공은 200이며 본문은 `format`(`zip`·`tar`·`tar.gz`), `entryCount`, `totalBytes`(선택 FILE 크기 합), `entries`(`name`, `type`, `size`)다.
- `dryRun`은 이름, 종류, 실제 크기, CRC·gzip 무결성을 본 실행과 같이 검증한다. 기존 대상과의 종류 충돌과 최종 quota를 보장하는 사전 승인은 아니다.
- 성공한 `dryRun`은 receipt를 남기지 않고 claim을 해제한다. 같은 key를 본 실행에 다시 써도 된다.
- 결정적 4xx로 실패한 `dryRun`은 본 실행처럼 receipt에 저장한다. 이 key로 본 실행을 보내면 다른 fingerprint라 409 `MUTATION_KEY_REUSED`다.

## 오류와 receipt

| 상태·코드                                                                       | 조건                                                                                                         | receipt |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------- |
| 400 `VFS_INVALID_EXTRACT_REQUEST`                                               | 구조, 키, mode, glob, 경로, MIME 오류, `exclude` 개수 초과                                                   | 저장    |
| 400 `VFS_INVALID_REVISION`                                                      | `sourceRevision`·`destinationRevision` 형식 오류                                                             | 저장    |
| 400 `VFS_EXTRACT_UNSUPPORTED_FORMAT`                                            | magic 불일치, gzip 안이 tar가 아님, zip64·암호화·미지원 method, V7 tar                                       | 저장    |
| 400 `VFS_EXTRACT_INVALID_ENTRY` (`entryIndex`, `entryName`)                     | 이름 규칙, link·장치, 중복·조상 충돌, 잘린 데이터, CRC·checksum·gzip trailer·header 불일치                   | 저장    |
| 400 `VFS_INVALID_MUTATION_REQUEST`                                              | 헤더 누락·형식 오류                                                                                          | 없음    |
| 404 `NAMESPACE_NOT_FOUND`                                                       | namespace 비활성                                                                                             | 없음    |
| 404 `VFS_NODE_NOT_FOUND` (`path`)                                               | source 부재·DIRECTORY·FILE 조상 아래·휴지통, destination 부모 부재, `destinationRevision`을 지정한 대상 부재 | 저장    |
| 409 `VFS_FEATURE_DISABLED`                                                      | capability 비활성                                                                                            | 없음    |
| 409 `MUTATION_IN_PROGRESS` (Retry-After), `MUTATION_KEY_REUSED`                 | 같은 key가 RESERVED, 같은 key에 다른 fingerprint                                                             | 없음    |
| 409 `VFS_NOT_DIRECTORY`                                                         | destination 또는 그 조상이 FILE                                                                              | 저장    |
| 409 `VFS_EXTRACT_TYPE_CONFLICT` (`entryIndex`, `entryName`, `path`)             | overwrite에서 entry와 기존 node의 종류가 다름                                                                | 저장    |
| 409 `VFS_REVISION_EXHAUSTED`                                                    | 변경할 node의 version 상한                                                                                   | 저장    |
| 412 `VFS_PRECONDITION_FAILED` (`path`, `current`)                               | source 또는 destination revision 불일치                                                                      | 저장    |
| 413 `VFS_EXTRACT_TOO_LARGE`                                                     | `message`에 `entries`·`bytes`·`entryBytes`·`ratio` 중 하나를 적는다                                          | 저장    |
| 413 `VFS_FILE_TOO_LARGE`, `VFS_QUOTA_EXCEEDED`, 기존 node·폴더·삭제·휴지통 한도 | 기존 한도                                                                                                    | 저장    |
| 413 `BAD_REQUEST`                                                               | 64 KiB JSON parser 한도 초과(fingerprint 전)                                                                 | 없음    |
| 503 `VFS_EXTRACT_BUSY` (Retry-After), `VFS_EXTRACT_TIMEOUT`                     | gate 포화, deadline                                                                                          | 없음    |
| 5xx                                                                             | 원본 소실, DB·storage 장애                                                                                   | 없음    |

- `entryIndex`는 exclude로 건너뛴 entry를 세지 않는 0부터의 선택 순번이다.
- `entryName`은 archive 안의 원래 이름이다.
- 현재 FILE의 CRC·길이·DEFLATE 오류는 그 FILE의 순번이다.
- 다음 header나 entry metadata가 손상되면 다음 선택 순번이다. 이름을 읽기 전이면 `entryName`은 빈 문자열이다.
- 제외 FILE의 본문을 읽다 손상되면 다음 선택 순번과 제외 FILE의 이름을 쓴다.
- 끝 블록 누락처럼 마지막 entry 뒤의 손상은 마지막으로 읽은 entry의 이름을 쓴다.
- gzip 손상은 어느 entry에서 났는지 알 수 없어 `entryName`이 빈 문자열이다.
- 413의 한도 종류는 `message`에만 적고 `limit` 필드는 공개하지 않는다.
- 저장되는 오류는 같은 key·같은 fingerprint에서 30일간 재생된다. 상태나 입력을 고친 뒤에는 새 key를 쓴다.

오류 우선순위는 다음과 같다.

1. 구조(400).
2. capability(409).
3. gate(503).
4. source 조건(404·412).
5. destination 조건(404·409·412).
6. 형식(400).
7. entry 순서대로 검증·한도(400·413).
8. 커밋(409 종류 충돌, 413 quota).

## 실행

1. extract 전용 raw JSON parser가 최대 64 KiB 원문 Buffer를 만든다. 일반 JSON·urlencoded parser에서는 제외한다. 이후 receipt claim, capability, gate, deadline timer, lease 갱신을 archive와 같이 처리한다. 기존 receipt 재생은 capability보다 먼저다.
2. capture 트랜잭션이 source FILE(`sourceRevision`), destination 조건(존재 시 DIRECTORY, `destinationRevision`), 부모 존재를 한 snapshot에서 확인한다. source Blob의 storageKey·size·sha256·encryptionIv와 DB wall-clock deadline을 돌려준다.
3. source 앞 512 byte를 range로 읽어 형식을 판별한다.
   - zip은 `PK\x03\x04` 또는 `PK\x05\x06`, gzip은 `1f 8b`, tar는 offset 257의 `ustar` 또는 전부 zero인 첫 512 byte다.
   - gzip 안이 tar가 아니면 미지원 형식이다.
4. entry를 순회한다.
   - tar·tar.gz: `storage.get` 전체 stream(source Blob에 IV가 있으면 `getEncrypted`) → 길이 가드 → gunzip(선택) → tar reader. 길이 가드는 storage가 짧게 응답하면 gzip 손상이 아닌 서버 오류로 만든다.
   - zip: range read로 EOCD, central directory, local header를 읽고 본문은 선택 entry만 연다.
   - entry마다 이름 검증, exclude, 한도, 업로드 순서다. 업로드는 `ContentIngressService`가 평문 cap으로 수행하고, 결과 Blob의 암호화는 namespace 정책을 따른다.
   - 한도 순서는 선택 entry 수, FILE 해제 합, entry 하나 크기, ZIP 압축비다.
   - gzip 압축비는 해제 출력 전체(제외 본문, 확장 헤더, padding 포함)의 누적이 1 MiB 이상이고 읽은 압축 byte × 한도를 넘는 순간 413이다. ZIP은 선택 FILE 하나가 1 MiB 이상이고 선언 크기가 압축 크기 × 한도를 넘으면 본문을 열기 전에 413이다.
   - 성공 전에 gzip EOF·trailer 검증과 모든 GET·해제·PUT 종료를 기다린다. 취소·오류·조기 중단은 reader 안에서 대기 중인 원본 stream까지 destroy하고 close를 기다린다.
   - storage 장애는 형식 오류로 바꾸지 않는다.
5. lease를 확인한 뒤 커밋 트랜잭션(`withMutation`)을 연다.
   - DB wall-clock deadline을 검사한다.
   - destination의 부모 사슬, 종류, 명시한 `destinationRevision`을 다시 검사한다. 불일치는 412, 대상이 없어졌으면 404다.
   - `clean`이고 대상이 있으면 대상을 재귀 삭제한 뒤 다시 만든다. 삭제 한도는 namespace의 동기 삭제 한도다.
   - entry를 순서대로 반영한다. 같은 경로 FILE은 node id를 유지하고 새 Blob row(참조 수 1)로 바꾸며 이전 Blob 참조 수를 줄인다. 없으면 만든다. 종류가 다르면 409다.
   - 카운터와 quota는 기존 `withMutation`이 집계하고 검사한다. 휴지통이 켜진 `clean`은 보관 byte가 남으므로 quota를 풀어 주지 않는다.
   - 공통 revision bump 뒤 같은 트랜잭션에서 destination을 다시 읽는다. 이 최종 resource와 `affectedRevisions`로 응답을 만들고 receipt를 완료한다.
   - 대상 하위가 바뀌면 대상과 조상의 revision이 함께 올라가고 변경 feed에 `updated`로 남는다.
6. 실패하면 진행 중인 stream과 업로드가 정착하기를 기다린 뒤 올린 object마다 삭제를 시도한다.
   - 확정 4xx이고 어떤 Blob도 참조하지 않으면 즉시 지운다.
   - 5xx, 취소, 불확정 commit, 참조 확인 실패는 보존하고 GC에 맡긴다.
   - 마지막에 gate, timer, listener, lease를 정리한다.

경로 중복·충돌 판정 상태는 선택 entry 수와 경로 깊이에 비례한다. 선택 entry 한도와 경로 4096 byte 한도가 상한이다.

## 설정

| 변수                                 | 기본       | 상한       | 뜻                                 |
| ------------------------------------ | ---------- | ---------- | ---------------------------------- |
| `STORIX_EXTRACT_MAX_CONCURRENCY`     | 1          | —          | 프로세스 안의 동시 실행 수         |
| `STORIX_EXTRACT_MAX_ENTRIES`         | 1000       | 10000      | 요청당 선택 entry 수               |
| `STORIX_EXTRACT_MAX_TOTAL_BYTES`     | 1073741824 | 1073741824 | 제외 FILE 포함 평문 FILE 크기의 합 |
| `STORIX_EXTRACT_MAX_RATIO`           | 100        | 10000      | 압축비                             |
| `STORIX_EXTRACT_MAX_SECONDS`         | 600        | 86400      | capture부터 commit까지의 deadline  |
| `STORIX_EXTRACT_RETRY_AFTER_SECONDS` | 10         | 3600       | gate 포화 응답의 Retry-After       |

- entry 하나의 상한은 namespace의 유효 FILE 크기 상한이다.
- gate는 API 프로세스 안의 동시 실행 수만 제한한다. 분산 공정성이나 cluster 전체 한도는 제공하지 않는다. archive gate와 분리한다.
- 요청 처리 전에 이미 끊긴 client는 원본을 읽지 않고 gate 슬롯과 claim을 바로 돌려준다.

## 무결성과 복구 경계

- 형식 미지원은 `VFS_EXTRACT_UNSUPPORTED_FORMAT`이다. 지원 형식의 잘린 header·본문, CRC·checksum·descriptor 불일치는 `VFS_EXTRACT_INVALID_ENTRY`다.
- ZIP CRC와 gzip trailer는 압축 형식의 무결성 검증이다. 원본 전체 SHA-256 검증이 아니다. ZIP range read는 Blob 전체 SHA-256을 다시 계산하지 않는다.
- 빈 archive와 모두 제외된 archive도 유효하다. `clean`이면 기존 대상을 지우고 빈 DIRECTORY를 만든다. `overwrite`는 기존 대상을 그대로 두고 없으면 빈 DIRECTORY를 만든다.
- 읽기 중 취소·오류·deadline은 대상을 바꾸지 않는다.
- 커밋 응답이 유실된 경우처럼 결과가 불명확하면 올린 object를 지우지 않는다. 같은 key로 재시도하면 완료 receipt를 재생하거나 다시 평가한다.

## 원본 보존 전제

archive와 같다. [파일 archive](./16-file-archive.md) "원본 보존 전제"와 api ADR-0048을 따른다. source Blob의 참조 수를 바꾸지 않고 읽는다.

- 운영자는 모든 API와 GC 실행에 같은 `STORIX_ORPHAN_GRACE_PERIOD`를 적용한다.
- API는 `STORIX_EXTRACT_MAX_SECONDS + 60 <= STORIX_ORPHAN_GRACE_PERIOD`만 검사한다.
- `extract`가 `globalAllowedCapabilities`에 있으면 위반 시 시작을 거부하고, 없으면 경고만 남긴다.
- 이 검사는 원본 보존 보증이 아니다. 원본 소실이나 storage 오류는 5xx이며 성공으로 해석하지 않는다.

## 운영

- 동기 요청은 기본 최대 600초다. 프록시와 호출자의 timeout은 이 상한에 응답 전송 여유를 더한 값보다 길어야 한다.
- SIGTERM drain의 기본 상한(25초)은 이 상한보다 짧아 진행 중 요청이 끊긴다. 끊긴 요청의 receipt는 lease 동안 RESERVED로 남고 같은 key 재시도가 takeover한다. 절차는 [파일 archive](./16-file-archive.md) "운영"과 같다.
- 5xx로 끝난 요청이 올린 object는 GC grace 안에 남는다. GC가 참조 없는 Blob으로 회수한다.
- compose 배포는 `STORIX_EXTRACT_*`가 `app` 환경으로 전달된다.

## 검증

- reader·planner·exclude: `tar-reader.spec.ts`, `zip-reader.spec.ts`, `extract-entry-plan.spec.ts`, `extract-exclude.spec.ts`.
- 실제 도구 호환: `extract-external-tools.spec.ts`가 Python `tarfile`·`zipfile`이 만든 archive를 읽는다.
- service: `extract.service.spec.ts`.
- 영속 계층: `extract-source.repository.shared-tests.ts`, `extract-commit.shared-tests.ts`가 PostgreSQL·SQLite에서 실행된다.
- HTTP: `extract-http.test-support.ts`가 PostgreSQL·S3와 SQLite·메모리 저장소에서 실행된다.
- 공개 계약: `extract-overwrite`, `extract-clean`, `extract-dry-run`, `extract-rejection`, `extract-limits`.

## 범위 밖

- bzip2, 7z, zip64, 암호화 압축, 다중 볼륨, `.tar.xz`.
- 업로드와 동시에 풀기.
- 최상위 폴더를 벗기는 `stripComponents`.
- 거부 패턴 목록. 호출자가 `dryRun` 목록으로 검증한다.
- 분산 gate.
