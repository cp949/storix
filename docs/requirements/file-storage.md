# Storix 범용 파일 저장 요구사항

## 목적과 범위

Storix는 호출 서버가 지정한 namespace 안에서 파일과 디렉터리, 바이트, 메타데이터, revision, snapshot을 관리한다. 이 문서는 특정 편집기·언어·파일 형식에 종속되지 않는 **범용 저장 계약**과 그 수용 조건을 정의한다. Jupyter Notebook은 소비자 사례 중 하나다. HTTP 경로, DB 구조, 오브젝트 저장 방식 같은 구현 방식은 요구사항이 지정하지 않는 한 제한하지 않는다.

호출 서버 또는 소비자 어댑터는 최종 사용자 인증, 소비자별 접근 권한, 파일 형식 파싱·검증, 소비자 고유 응답 형식을 담당한다. Storix는 허용된 파일 바이트를 재해석하거나 정규화하지 않는다. Jupyter 어댑터라면 노트북 JSON·`nbformat` 정책과 Jupyter Contents API 응답을 담당한다.

## 용어와 진행 상태

- **namespace**: Storix가 관리하는 독립 파일 공간. 호출 서버는 자체 권한 판단 후 대상 namespace를 선택한다.
- **파일 ID**: 이름·경로가 바뀌어도 같은 파일을 구분하는 식별자. 삭제 후 같은 경로에 만든 파일에는 새 ID를 부여한다.
- **revision**: 파일 상태의 변경을 구분하는 불투명한 식별자. 호출자는 내용이나 숫자 순서를 해석하지 않고 동등성 비교에만 쓴다.
- **콘텐츠 해시**: 읽기에서 반환되는 파일 바이트 전체에 대한 SHA-256 값. revision과 용도가 다르다.
- **스냅샷**: 생성 시점의 파일 바이트와 그 메타데이터를 보존하는 불변 저장 기록. 소비자는 이를 체크포인트·복구 지점으로 사용할 수 있다.
- **capability**: 하나의 소비자 사용 사례를 완성하는 선택 기능 묶음. 관련 연산은 일부만 활성화되어 사용할 수 없는 상태가 되지 않도록 함께 설정한다.
- **진행 상태**: `미착수` / `진행 중` / `검증 완료` / `보류`. 판정 근거는 공개 계약, 코드, 자동 검증, 배포·소비자 검증을 구분한다. 공개 계약만 대조했거나 수용 조건을 만족하지 않는 부분이 남으면 `검증 완료`로 표시하지 않는다.
- `[x]`는 이 문서의 수용 조건이 공개 계약·코드와 자동 검증 근거로 확인된 항목이다. `[ ]`는 갭 또는 필요한 검증이 남은 항목이다. 배포 환경과 특정 소비자 연동은 별도로 검증한다.
- 요구사항이나 구현이 바뀌면 같은 변경에서 해당 RQ의 상태와 판정 근거를 갱신한다. `RQ-NNN`은 요구사항 ID이며 [ROADMAP](../ROADMAP.md)의 실행 항목 ID와 구분한다.

## 1. 호출과 격리

### RQ-001 호출 서버 인증

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 전역 API 키 가드와 인증 단위 테스트에서 유효·누락·오류 자격을 확인했다. SQLite 계약 검증(`pnpm contract`)에서 `api-key-required`(누락·오류·비Bearer 자격의 401, 존재 여부·본문 미노출, 인증 없는 변경 거부)가 통과했다.
- Storix는 보호 대상 읽기·쓰기 요청에서 호출 서버의 자격을 검증하고, 자격이 없거나 유효하지 않으면 파일 존재 여부나 본문을 노출하지 않고 거부해야 한다.
- 최종 사용자 인증 결과를 Storix가 직접 판단할 필요는 없다. 호출자가 보낸 최종 사용자 식별값은 감사 정보일 수 있으나, 그 값만으로 권한을 부여해서는 안 된다.
- **수용 조건:** 같은 요청에 대해 유효한 서비스 자격은 허용되고, 누락·오류 자격은 거부된다.

### RQ-002 namespace 격리

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 파일·스냅샷 조회와 변경이 namespace로 제한되며, 다른 namespace 스냅샷 복원 거부 사례를 확인했다. SQLite 계약 검증에서 `namespace-isolation`(같은 경로의 독립 파일, 다른 namespace의 revision·snapshot ID로 조회·복원 거부, 삭제의 격리)이 통과했다.
- 모든 파일·스냅샷 요청은 namespace를 명시해야 한다. 파일 ID, 경로, 스냅샷 ID가 같거나 비슷해도 다른 namespace의 자원을 조회·변경할 수 없어야 한다.
- **수용 조건:** namespace A에서 얻은 식별자로 namespace B의 파일·스냅샷을 읽거나 변경할 수 없다.

### RQ-003 경로 계약

- [x] **진행 상태:** 로컬 코드·통합 검증 완료
- **판정 근거:** `/api/v2`의 파일·snapshot 경로에 공통 절대경로·NFC·허용 문자·UTF-8 이름 255바이트·정규 절대경로 4096바이트 상한을 적용했다. TREE 내부 상대경로와 이동·복사 결과·하위 경로에도 같은 한도를 적용하며, 경로 오류는 400 `VFS_INVALID_PATH`로 거부한다. API 단위 테스트 76 suites/674 tests, 인증 파일 HTTP L1 1 suite/139 tests, 공개 파일 HTTP L1 1 suite/11 tests, PostgreSQL L2 27 suites/410 tests, SQLite L2 12 suites/213 tests가 현재 HEAD에서 통과했다. `pnpm typecheck`, `pnpm lint`, `pnpm build`도 exit 0이다. 실제 사용처 배포·전용 인스턴스 초기화·데이터 복구 검증은 수행하지 않았다. SQLite 계약 검증에서 `path-normalization`(중복 구분자·`.`·끝 `/` 정규화, 대소문자·NFC 이름 보존)과 `path-rejection`(`..`·상대경로·백슬래시·제어·Bidi 문자·NFD·이름 255바이트 초과·경로 4096바이트 초과의 400 `VFS_INVALID_PATH`와 트리 무변경, 부모 자동 생성 없음)이 통과했다.
- Storix는 경로의 절대·상대 여부, 구분자, 정규화, 허용 문자, 최대 길이, `..` 처리와 디렉터리 부모 생성 여부를 공개 계약으로 정의해야 한다. 같은 의미의 경로가 서로 다른 파일을 뜻하거나, 경로 해석으로 namespace 밖에 접근해서는 안 된다.
- **수용 조건:** 정상 경로는 일관된 정규 경로로 식별되고, 허용하지 않는 경로는 저장 변경 없이 명시적으로 거부된다.

## 2. 파일 생성·조회·변경

### RQ-004 바이트 무손실 보존

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 원시 바이트 스트림 저장·조회와 바이너리 왕복 검증으로 본문 변환이 없음을 확인했다. SQLite 계약 검증에서 `byte-roundtrip`(빈 파일, 0x00~0xff, BOM, 혼합 개행, 비UTF-8, 1MiB 무작위를 조건부·무조건 저장 경로 모두로 왕복, 바이트·SHA-256·크기 일치)이 통과했다.
- Storix는 파일 형식과 무관하게 전달받은 바이트를 보존하고 전체 조회에서 동일하게 반환해야 한다. JSON, 노트북, 이미지나 임의 바이너리 등 콘텐츠 의미를 해석하거나 정규화하지 않는다.
- **수용 조건:** 서로 다른 바이트열을 각각 저장·조회했을 때 입력과 출력의 바이트 및 전체 SHA-256이 일치한다.

### RQ-005 존재하지 않는 파일의 조건부 생성

- [x] **진행 상태:** 로컬 코드·통합 검증 완료
- **판정 근거:** 조건부 콘텐츠 생성의 `resource.id`(VFS 노드 UUID)·정규 경로·`resource.revision`·수정 시각을 공개한다. PostgreSQL `fs.integration-spec.ts` L1 140/140에서 동시 생성의 단일 승자, receipt 재생, 이동·교체 시 ID 유지를 확인했다. 삭제·동일 경로 FILE 재생성 시 새 ID를 확인하는 단언은 전체 실행 뒤 보강했으며 해당 사례만 단독 1/1 통과했다. 최종 PostgreSQL L2의 파일 HTTP suite는 통과했고 SQLite L2는 12 suites/213 tests 통과했다. PostgreSQL L2 전체는 기존 412 repository 기대값의 `id` 누락으로 26 suites 통과·1 suite 실패했으며, 기대값 수정 뒤 해당 spec 114/114가 통과했다. SQLite 계약 검증(`pnpm contract`)에서 `conditional-create`(존재하는 경로의 412와 기존 바이트 보존)와 `conditional-create-race`(동시 생성의 단일 승자와 바이너리 무손실) 2개가 통과했다.
- 호출자는 지정 경로에 파일이 없을 때만 전체 바이트를 생성할 수 있어야 한다. 이미 파일이 있으면 기존 파일을 보존하고 충돌 오류를 반환해야 한다. 성공 결과에는 파일 ID, 정규 경로, revision, 수정 시각이 포함되어야 한다.
- **수용 조건:** 같은 경로에 대한 동시 조건부 생성 두 건 중 최대 한 건만 성공하고, 성공한 파일의 바이트가 온전하다.

### RQ-006 전체 파일 조회

- [x] **진행 상태:** 로컬 코드·통합 검증 완료
- **판정 근거:** 인증된 전체 `GET /fs/content` 200의 `X-Storix-File-Id`·`X-Storix-Revision`·`X-Storix-Sha256`이 반환한 바이트와 같은 노드/Blob 상태를 식별한다. PostgreSQL `fs.integration-spec.ts` L1 141/141에서 저장·교체·재시작, stat 대조, 교체 경합을 확인했고, `encrypted-content.integration-spec.ts` L1 5/5에서 복호화 바이트의 해시를 확인했다. 최종 PostgreSQL L2는 관련 suite 통과, SQLite L2는 12 suites/213 tests 통과했다(전체 PostgreSQL L2의 기존 412 repository 기대값 실패는 수정 후 해당 spec 114/114 통과). Range 206에는 `X-Storix-File-Id`·`X-Storix-Revision`을 제공하며, 전체 파일의 `X-Storix-Sha256`은 제공하지 않는다. SQLite 계약 검증에서 `full-read-identity`(저장·교체 직후 헤더가 파일 ID·revision·SHA-256과 일치, 디렉터리 409와 부재 404 구분)가 통과했다. `restart-persistence`(재시작 전후로 바이트·`X-Storix-*` 헤더·stat이 같음)가 재시작 후 조회를 확인했다.
- 호출자는 namespace와 경로로 현재 파일 전체를 읽을 수 있어야 한다. 조회 결과에는 반환한 바이트에 대응하는 파일 ID, revision, 콘텐츠 해시를 식별할 수단이 있어야 한다. 디렉터리와 파일 부재는 구분해야 한다.
- **수용 조건:** 저장 직후와 Storix 재시작 후 조회한 바이트와 해당 revision·해시가 일관된다.

### RQ-007 본문 없는 메타데이터 조회

- [x] **진행 상태:** 로컬 코드·통합 검증 완료
- **판정 근거:** `GET /fs/stat`의 단일 응답에 노드 ID·정규 경로·크기·MIME·수정 시각·`revision`·`sha256`이 있으며 노드와 참조 Blob을 한 읽기 상태에서 조회한다. PostgreSQL `fs.integration-spec.ts` L1 140/140에서 전체 콘텐츠와 크기·SHA-256 일치, 빈 FILE 해시, DIRECTORY의 `sha256: null`, namespace 격리와 부재를 확인했다. 최종 PostgreSQL L2는 관련 suite 통과, SQLite L2는 12 suites/213 tests 통과했다. 기존 412 repository 기대값에 새 `id`가 없어 PostgreSQL L2의 한 suite가 실패했으며 기대값 수정 후 해당 spec 114/114 통과했다. SQLite 계약 검증에서 `stat-metadata`(ID·경로·크기·MIME·revision·SHA-256이 전체 조회와 일치, 빈 파일 해시, 디렉터리 `sha256: null`, 부재 404)가 통과했다.
- 호출자는 파일 본문을 전송받지 않고 파일 ID, 정규 경로, 바이트 크기, MIME 유형, 마지막 수정 시각, 현재 revision, 콘텐츠 해시를 함께 조회할 수 있어야 한다. 해시는 Storix가 전체 조회에서 반환하는 정확한 바이트를 기준으로 계산해야 한다.
- **수용 조건:** 메타데이터의 크기·해시는 같은 revision으로 조회한 전체 파일의 바이트 길이·SHA-256과 일치한다.

### RQ-008 revision 조건부 전체 교체

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 정확한 revision 조건의 전체 교체와 오래된 revision 충돌을 PostgreSQL 통합 사례로 확인했다. SQLite 계약 검증에서 `revision-replace`(교체 시 revision 변경, 오래된 revision의 412와 바이트·revision·수정 시각 유지)와 `revision-replace-race`(같은 revision 동시 교체 4건 중 1건만 성공)가 통과했다.
- 호출자는 읽은 revision을 조건으로 파일 전체 바이트를 교체할 수 있어야 한다. 조건이 현재 revision과 다르면 충돌을 반환하고 파일 바이트·revision·수정 시각을 바꾸지 않아야 한다. 성공한 변경은 이전과 다른 revision을 반환해야 한다.
- **수용 조건:** 같은 revision을 조건으로 한 두 교체 요청 중 최대 한 건만 성공한다.

### RQ-009 원자적 파일 저장

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 업로드 중단·한도 초과 및 복원·스냅샷 receipt 실패의 롤백 사례를 PostgreSQL 통합 검증에서 확인했다. SQLite 계약 검증에서 `save-atomicity`(checksum 불일치 422와 중단된 업로드 뒤 기존 파일·revision 유지, 새 경로에 부분 파일 없음, 같은 revision 재저장 성공)가 통과했다. 계약은 한도 초과 롤백과 복원·snapshot receipt 실패를 포함하지 않는다.
- 생성·교체·복원은 호출자에게 전부 적용되거나 전혀 적용되지 않은 결과로 관찰되어야 한다. 업로드 중단, 저장 장애, 한도 초과 시 이전 파일에 부분 바이트나 새 revision을 노출해서는 안 된다. 성공 응답의 revision과 수정 시각은 실제로 읽을 수 있는 완료 상태를 가리켜야 한다.
- **수용 조건:** 실패 지점별 재조회에서 기존 파일과 revision이 유지되며, 성공 직후에는 새 파일 전체를 읽을 수 있다.

### RQ-010 순서와 재시작 후 지속성

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 동시 조건부 변경과 SQLite 스냅샷·파일·receipt 재시작 지속성을 통합 검증에서 확인했다. SQLite 계약 검증에서 `concurrent-write-restart`(같은 revision의 동시 교체 4건 중 1건만 성공하고 재시작 뒤에도 승자의 바이트·revision 유지, 옛 revision은 412)와 `restart-persistence`(재시작 전후로 파일 바이트·헤더·stat, 디렉터리, snapshot 메타데이터·바이트·목록이 같음)가 통과했다.
- 같은 파일에 대한 조건부 변경은 하나의 확정 순서를 가져야 하며, 성공 응답 이후 Storix 재시작으로 이미 완료된 파일·revision·스냅샷이 사라져서는 안 된다. 수정 시각과 revision은 동일한 확정 상태를 가리켜야 한다.
- **수용 조건:** 동시 저장과 재시작을 포함한 시나리오에서 성공 결과를 다시 조회할 수 있고 조용한 마지막 쓰기 승리가 없다.

## 3. 재시도와 스냅샷

### RQ-011 변경 요청의 멱등성

- [x] **진행 상태:** 검증 완료
- **판정 근거:** PostgreSQL 통합 검증에서 조건부 변경·raw upload의 receipt 재생과 앱 재시작 후 결과 재생, 같은 키의 다른 fingerprint에 대한 `MUTATION_KEY_REUSED`를 확인했다. 파일 크기 상한을 넘긴 스트리밍 요청은 413 receipt를 만들지 않고, 같은 키의 다음 요청을 다시 평가하는 것도 확인했다. SQLite 계약 검증에서 `mutation-replay`(같은 키·같은 요청은 그 사이 파일이 바뀌어도 최초 status·본문·`X-Request-Id`를 재생하고 다시 적용하지 않음, 같은 키의 다른 요청은 409 `MUTATION_KEY_REUSED`; 조건부 저장과 delete 대상)와 `mutation-replay-restart`(재시작 뒤 성공·412·delete 응답을 최초 결과로 재생)가 통과했다. 계약은 snapshot 생성·복원·삭제와 raw upload의 멱등성, 크기 상한 초과 요청, 진행 중 key(`MUTATION_IN_PROGRESS`)를 포함하지 않는다.
- 호출자는 생성·교체·스냅샷 생성·복원·삭제 요청에 멱등성 키를 지정할 수 있어야 한다. 유효한 namespace와 호출자 범위에서 요청 fingerprint를 완성할 수 있으면 namespace, 호출자 범위, 키, 요청 내용으로 동일 요청을 판별하고, 같은 요청의 재전송에는 최초 확정 결과를 재생해야 한다. 같은 키를 다른 요청에 사용하면 재사용 오류를 반환해야 한다. fingerprint를 완성하기 전에 거부한 요청은 receipt를 남기지 않고 재시도 시 다시 평가한다. 특히 파일 크기 상한을 넘긴 콘텐츠 스트림은 본문 전체를 소비해 hash하지 않으므로 최초 응답 bytes와 request ID의 재생을 보장하지 않는다.
- **수용 조건:** fingerprint를 완성할 수 있는 요청은 응답 유실 직후와 Storix 재시작 후 재시도해도 변경을 한 번만 적용하고 최초 확정 결과를 재생한다. fingerprint 이전에 끝난 오류는 receipt 없이 재평가되며, 그 최초 응답 bytes의 동일성은 보장하지 않는다.

### RQ-012 스냅샷 생성

- [x] **진행 상태:** 로컬 코드·통합 검증 완료
- **판정 근거:** 조건부 FILE snapshot 생성 결과에 snapshot ID·`rootNodeId`(원본 파일 ID)·원본 경로·revision·생성 시각·크기·보존 바이트 `sha256`이 포함된다. PostgreSQL `fs.integration-spec.ts` L1 141/141에서 원본 교체와 캡처 경합의 revision·해시·바이트 일치 및 조건 실패 시 무생성을 확인했다. SQLite ENCRYPTED snapshot L1은 최초 8/10 통과 후 기존 412 기대값 두 곳을 수정해 해당 사례 2/2 통과했다. 최종 PostgreSQL L2의 파일 HTTP suite에서 snapshot 삭제 경합 사례가 통과했고 SQLite L2 12 suites/213 tests에서 원본 이동 사례가 통과했다. PostgreSQL L2 전체의 기존 412 repository 기대값 실패는 수정 후 해당 spec 114/114 통과했다. SQLite 계약 검증에서 `snapshot-create`(원본 파일 ID·경로·revision·크기·해시·생성 시각 반환, `sourceRevision` 불일치 412와 snapshot 미생성)와 `snapshot-create-race`(교체가 진행되는 동안 요청한 snapshot이 지정한 revision의 바이트만 보존하고, 커밋 이후 요청은 412)가 통과했다. 계약은 TREE snapshot을 포함하지 않는다.
- 호출자는 지정 파일의 현재 revision을 조건으로 불변 스냅샷을 만들 수 있어야 한다. 생성 결과에는 스냅샷 ID, 원본 파일 ID·경로·revision, 생성 시각, 크기, 해시가 포함되어야 한다. 조건이 맞지 않으면 스냅샷을 남기지 않아야 한다.
- **수용 조건:** 파일 변경과 스냅샷 생성이 경합할 때 스냅샷은 명시한 revision의 바이트만 보존하거나 충돌로 거부된다.

### RQ-013 파일별 스냅샷 목록

- [x] **진행 상태:** 로컬 코드·통합 검증 완료
- **판정 근거:** API v2에 namespace와 immutable `rootNodeId`로 FILE snapshot을 keyset 조회하는 endpoint와 DB 복합 인덱스를 추가했다. PostgreSQL repository L1 20/20, SQLite repository L1 41/41, SQLite HTTP L1 11/11 통과. PostgreSQL HTTP L1 첫 실행은 stale 오류 기대 2건과 lease-renewal timing assertion 1건으로 141/143, stale 기대를 갱신한 재실행은 142/143이었다. 승인된 단일 timing 실패 재실행 1/1 통과 후 L2 PostgreSQL 전체 27 suites/416 tests와 SQLite 전체 12 suites/217 tests가 통과했다. L2에는 PostgreSQL/SQLite repository, HTTP, migration 검증이 포함된다. 실 Jupyter/WAS 연동은 검증하지 않았다. SQLite 계약 검증에서 `snapshot-list`(snapshot 5건을 limit 2로 순회해 누락·중복 없이 조회, 이동과 삭제 후 같은 경로 재생성 뒤에도 소속 유지)가 통과했다. 계약은 목록 정렬 순서를 검증하지 않는다.
- 호출자는 파일 ID를 기준으로 해당 파일의 스냅샷을 페이지 단위로 나열할 수 있어야 한다. 각 항목은 스냅샷 ID, 생성 시각, 원본 revision, 크기, 해시를 포함해야 한다. 파일의 경로 변경은 해당 목록의 소속을 바꾸지 않으며, 삭제 후 같은 경로에 새로 만든 파일의 목록과 섞이지 않아야 한다.
- **수용 조건:** 스냅샷 여러 건을 누락·중복 없이 조회하고, 파일 이동·동일 경로 재생성 후에도 소속이 유지된다.

### RQ-014 스냅샷 바이트 조회

- [x] **진행 상태:** 로컬 코드·통합 검증 완료
- **판정 근거:** FILE snapshot 생성·ID 조회는 보존 root entry의 Blob SHA-256을 반환하고 전체 바이트 조회는 같은 보존 Blob을 읽는다. SQLite ENCRYPTED snapshot L1에서 생성·receipt 재생·재시작·원본 교체·삭제 뒤 메타데이터와 바이트 일치를 확인했다(최초 8/10, 기존 412 기대값 수정 후 실패 사례 2/2). 최종 SQLite L2 12 suites/213 tests에서 원본 이동 직후의 불변성을 확인했고, PostgreSQL L2의 파일 HTTP suite에서 snapshot 삭제 경합 사례가 통과했다. PostgreSQL L2 전체의 기존 412 repository 기대값 실패는 수정 후 해당 spec 114/114 통과했다. TREE의 `sha256`은 `null`이다. SQLite 계약 검증에서 `snapshot-immutable`(원본 수정·이동·삭제 뒤에도 snapshot 바이트·크기·해시가 생성 직후와 같음)이 통과했다. 계약은 암호화 namespace와 Range 조회를 포함하지 않는다.
- 호출자는 스냅샷 ID로 생성 당시의 전체 파일 바이트와 메타데이터를 읽을 수 있어야 한다. 원본 파일의 수정·이동·삭제는 보존 중인 스냅샷 내용을 바꾸지 않아야 한다.
- **수용 조건:** 원본 변경 또는 삭제 뒤에도 스냅샷 바이트·크기·해시가 생성 직후와 같다.

### RQ-015 조건부 스냅샷 복원

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 부재·revision 조건별 복원, 충돌 시 무변경, 새 revision과 스냅샷 보존을 PostgreSQL 통합 사례로 확인했다. SQLite 계약 검증에서 `snapshot-restore`(오래된 대상 revision·부재 조건 불일치 412와 무변경, 조건 누락 428, 정상 복원 후 바이트가 snapshot과 같고 revision이 달라짐, 부재 경로 201 복원, snapshot 보존)가 통과했다.
- 호출자는 스냅샷 바이트를 지정 경로의 현재 파일로 복원할 수 있어야 한다. 대상 파일이 있으면 현재 revision 일치 조건이, 없으면 부재 조건이 필요하다. 성공 시 대상 파일에 새 revision을 발급하고 스냅샷 자체는 보존해야 한다.
- **수용 조건:** 오래된 대상 revision으로 복원하면 변경 없이 충돌하며, 정상 복원 후 대상 바이트는 스냅샷과 같고 revision은 복원 전과 다르다.

### RQ-016 스냅샷 삭제와 보존

- [x] **진행 상태:** 검증 완료
- **판정 근거:** 명시적 삭제와 다른 스냅샷·현재 파일의 보존을 통합 사례와 삭제 트랜잭션에서 확인했다. SQLite 계약 검증에서 `snapshot-delete`(한 snapshot 삭제 뒤 삭제한 snapshot은 404, 현재 파일·나머지 snapshot의 메타데이터·바이트·목록이 그대로)가 통과했다. 계약은 자동 만료·개수 제한을 다루지 않는다(도입하지 않았다).
- 호출자는 특정 스냅샷을 명시적으로 삭제할 수 있어야 한다. 삭제는 현재 파일과 다른 스냅샷을 변경해서는 안 된다. 자동 만료·개수 제한을 도입한다면 보존 정책과 삭제 시점을 공개 계약으로 먼저 정의해야 하며, 정의되지 않은 자동 삭제는 허용하지 않는다.
- **수용 조건:** 하나의 스냅샷 삭제 뒤 현재 파일과 나머지 스냅샷을 동일하게 조회할 수 있다.

## 4. 오류·한도·운영 계약

### RQ-017 크기 및 저장량 한도

- [x] **진행 상태:** 완료
- **판정 근거:** 인증된 `GET /api/v2/namespaces/{id}`가 적용 단일 파일 상한 `limits.maxFileSizeBytes`와 논리 quota의 `limitBytes`·`usedBytes`를 바이트 단위 10진 문자열로 반환한다. 파일 상한은 namespace 재정의와 `STORIX_MAX_FILE_SIZE_BYTES` 중 작은 값이고 전역 기본값은 `5368709120`이다. DTO/OpenAPI L0 2 suites/13 tests, namespace HTTP L1 20/20에서 값·quota 사용량·인증 거부를 확인했다. PostgreSQL 전체 L2 27 suites/419 tests와 SQLite 전체 L2 12 suites/217 tests가 통과했다. 파일 HTTP L2에서 파일 크기 초과 업로드 413 `VFS_FILE_TOO_LARGE`, snapshot 생성 초과 413 `VFS_SNAPSHOT_LIMIT_EXCEEDED`, 복원 quota 초과 413 `VFS_QUOTA_EXCEEDED`를 확인하고 대상 파일·snapshot·Blob 참조·root revision·논리 사용량의 무변경을 해당 사례에 맞춰 단언했다. PostgreSQL repository L1은 노드 quota 114/114, snapshot 상한 20/20이 통과했다. `pnpm typecheck`와 `pnpm lint`도 최종 테스트 변경 후 exit 0이다. 실제 배포 설정, WAS/Jupyter 연동은 검증하지 않았다. SQLite 계약 검증(`small-limits` 프로필: 파일 상한 1200, snapshot 상한 800, 논리 상한 2000 바이트)에서 `limits-visible`(namespace 조회가 상한·사용량을 노출하고 저장·snapshot 생성이 사용량에 반영), `file-size-rejection`(413 `VFS_FILE_TOO_LARGE`, 새 경로·교체 모두 무변경, 상한과 같은 크기는 허용), `quota-rejection`(413 `VFS_QUOTA_EXCEEDED`, 기존 파일·사용량 무변경), `snapshot-limit-rejection`(413 `VFS_SNAPSHOT_LIMIT_EXCEEDED`, snapshot 미생성), `snapshot-restore-quota-rejection`(복원 413 `VFS_QUOTA_EXCEEDED`, 대상 경로·snapshot·사용량 무변경)이 통과했다. 계약은 namespace별 상한 재정의(관리자 API), TREE snapshot·삭제·복사 노드 상한, 휴지통 사용량, 보존 snapshot 상한을 다루지 않는다.
- Storix는 파일 한 건의 최대 바이트 수와 namespace의 현재 파일·보존 스냅샷 사용량 상한을 적용할 수 있어야 한다. 호출자는 적용 한도와 사용량을 확인할 수 있어야 한다. 초과 요청은 기존 파일·스냅샷·revision을 변경하지 않고 한도 유형을 식별할 수 있는 오류를 반환해야 한다.
- **수용 조건:** 업로드와 스냅샷 생성·복원 각각의 한도 초과에서 부분 변경이 없고 오류 유형이 구분된다.

### RQ-018 안정적인 오류 분류

- [x] **진행 상태:** 완료
- **판정 근거:** 오류 계약은 `apps/api/openapi.yaml`에 공개했다. 인증/namespace·node·snapshot 부재는 401/404 코드, 입력·유형·revision·key·상한 거부는 기존 4xx 코드, `DB_BUSY`는 503, 식별된 transient DB/Blob 장애는 503 `STORAGE_UNAVAILABLE`, 식별된 permanent 저장 장애는 500 `STORAGE_FAILURE`, 미분류 예외는 500 `INTERNAL_ERROR`다. 분류할 수 없는 500은 안전한 고정 메시지를 반환하고 내부 예외·저장소 정보·파일 바이트·비밀을 노출하지 않는다. 같은 key 자동 재시도 가능 코드는 `DB_BUSY`, `STORAGE_UNAVAILABLE`, `MUTATION_IN_PROGRESS`이며 `Retry-After`가 있으면 먼저 기다린다. 결정적 4xx 오류 receipt는 최초 응답을 재생하므로 상태·입력을 고친 요청은 새 key를 사용한다. `STORAGE_FAILURE`와 `INTERNAL_ERROR`는 자동 재시도를 약속하지 않고 원인 조사를 요구한다. SQLite 계약 검증에서 `error-codes`(인증 실패 401 `UNAUTHORIZED`, namespace 없음 404 `NAMESPACE_NOT_FOUND`, 경로 오류 400 `VFS_INVALID_PATH`, 파일 없음 404 `VFS_NODE_NOT_FOUND`, 유형 오류 409 `VFS_IS_DIRECTORY`·`VFS_NOT_DIRECTORY`, revision 형식 오류 400 `VFS_INVALID_REVISION`, revision 충돌 412 `VFS_PRECONDITION_FAILED`, 조건 누락 428 `VFS_PRECONDITION_REQUIRED`, namespace 생성의 key 누락 400 `IDEMPOTENCY_KEY_REQUIRED`, key 재사용 409 `MUTATION_KEY_REUSED`, snapshot 없음 404 `VFS_SNAPSHOT_NOT_FOUND`가 상태와 `code`로 구분되고 `requestId`가 있으며 code가 서로 겹치지 않음)와 한도 계약 5개(413 세 코드 구분)가 통과했다. 계약은 `DB_BUSY`·`STORAGE_UNAVAILABLE`·`STORAGE_FAILURE`·`INTERNAL_ERROR` 발생과 `Retry-After`를 다루지 않는다(공개 HTTP만으로 저장소 장애를 일으킬 수 없다).
- **자동 검증 근거:** 단위 `pnpm test`는 API 79 suites/752 tests 통과, `route-coverage.spec.ts` 포함. 표적 PostgreSQL L1: `fs.integration-spec.ts` 146/146, `content-streaming.integration-spec.ts` 4/4, `namespace.integration-spec.ts` 21/21. SQLite L1 `vfs-snapshot.sqlite.integration-spec.ts` 12/12. 최종 L2 `pnpm test:integration --filter='!@cp949/storix-demo1-was'` 27 suites/424 tests, `pnpm --filter @cp949/storix-api test:integration:sqlite` 12 suites/218 tests 통과. root L0 typecheck/lint/test/build도 통과했다. 리뷰에서 제기된 plan의 전 연산별 장애 주입 확장은 사용자 결정으로 수행하지 않았고, 확정 DELTA-03 브리프의 HTTP/receipt/stream 경계를 검증했다.
- **검증 경계:** 오류 주입은 repository·S3 SDK seam 및 실제 SQLite gate를 사용한 자동 테스트다. 소비자 어댑터의 자동 재시도 동작, 실행 중인 외부 DB/스토리지의 실장애와 복구, production 배포는 검증하지 않았다. 응답 중단은 raw HTTP client 수준에서만 확인했다.
- Storix는 최소한 호출 인증 실패, namespace 없음, 경로 오류, 파일 없음, 파일 유형 오류, revision 충돌, 멱등성 키 재사용, 스냅샷 없음, 크기·저장량 초과, 저장 장애를 기계적으로 구분할 수 있는 오류 코드를 제공해야 한다. 재시도 가능한 일시적 오류와 확정된 거부도 구분해야 한다.
- **수용 조건:** 호출 서버가 오류 메시지 문자열을 파싱하지 않고 코드만으로 각 경우를 처리할 수 있다.

### RQ-019 감사에 필요한 호출 정보

- [x] **진행 상태:** 로컬 코드·자동 검증 완료
- **판정 근거:** 성공 요청은 기존 `AuditLogInterceptor`가 request ID, caller, namespace, operation, 대상 경로, HTTP 결과를 기록한다. `InvalidApiKeyError`는 공통 예외 필터에서 `request_id`, HTTP method와 request path로 구성한 128자 operation, 전체 request path, 401 결과를 best-effort 기록하며 caller·namespace는 null로 둔다. 감사 행은 nullable `snapshot_id`를 가지며 생성 결과와 개별 ID 경로를 기록하고 목록은 null을 유지한다. snapshot 감사 ID는 PostgreSQL/SQLite migration과 저장 테스트로 확인했다. 단위·PostgreSQL 통합 검증은 키 원문과 본문 미기록 및 저장 실패 시 401 응답 보존을 확인한다.
- **자동 검증 근거:** `pnpm test` 79 suites/768 tests, PostgreSQL L2 27 suites/437 tests, SQLite L2 13 suites/228 tests 통과. `pnpm typecheck`, `pnpm lint`, `pnpm build` 통과. PostgreSQL 감사 E2E 6 tests는 HTTP 인증 거부와 snapshot ID별 생성·조회·entries·content·restore·delete 및 목록 미기록을 확인했다.
- **검증 경계:** 로컬 자동 테스트의 disposable PostgreSQL/SQLite만 확인했다. 운영 DB migration 적용, 운영 로그 조회·보존, 외부 호출 서버의 요청 ID 연결은 검증하지 않았다. 공개 경로 및 API key 거부 이외의 새 4xx 감사 경로는 포함하지 않는다.
- Storix는 읽기·변경 요청에 대해 요청 ID, 호출 서버 식별, namespace, 대상 파일 또는 스냅샷, 작업 유형, 결과를 추적할 수 있어야 한다. 호출자가 제공한 최종 사용자 식별값은 자기신고 값으로 취급하고 Storix의 권한 판단 근거로 사용하지 않아야 한다.
- **수용 조건:** 호출 서버의 요청 ID로 Storix의 성공·거부 기록을 연결할 수 있고, 파일 본문과 인증 비밀은 기록에 포함되지 않는다.

### RQ-020 호출 계약 공개

- [x] **진행 상태:** 공개 계약·정적 대조 완료
- **판정 근거:** `apps/api/openapi.yaml`에 namespace 조회를 통한 실행 중 단일 파일 상한·논리 사용량 확인, 인증된 파일 생성·조회·조건부 교체·FILE snapshot 생성/조회/콘텐츠/복원 curl 흐름을 추가했다. 응답의 파일 ID·불투명 revision·전체 바이트 SHA-256 의미, 조건부 오류, namespace/scope/key receipt identity와 완료 후 30일 재생 및 만료 후 재평가 가능성을 함께 설명한다. 적용 경로·요청 필드·응답 필드는 현재 라우트·DTO 및 기존 통합 테스트와 정적으로 대조했다. YAML 구문 검사 결과는 작업 DELTA에 기록한다.
- **검증 경계:** 로컬 문서·코드 계약 대조만 수행한다. 예시를 배포된 서버나 외부 WAS에서 실행하지 않았고, namespace 운영 설정·실제 저장소·운영 receipt 보존/GC를 검증하지 않았다. TREE snapshot은 전체 OpenAPI 계약에 남아 있으나 이 요구사항의 필수 노트북 예시에는 포함하지 않는다.
- Storix는 요청 조건, 성공 응답 필드, revision·해시의 의미, 오류 코드, 경로 규칙, 멱등성 키의 범위·보존 기간, 크기·저장량 한도를 호출 서버가 확인할 수 있도록 문서화해야 한다. 배포 시 설정에 따라 달라지는 값은 실행 중 확인 방법을 제공해야 한다.
- **수용 조건:** 소비자 어댑터 구현자가 Storix 내부 코드나 DB를 읽지 않고도 생성→조회→조건부 교체→스냅샷→복원 흐름을 구현할 수 있다.

### RQ-021 Range 부분 콘텐츠 조회

- [x] **진행 상태:** 구현 및 계약 검증 완료
- **판정 근거:** 단일 Range의 시작-끝·열린 끝·suffix와 clipping 및 긴 suffix 처리, 잘못된 문법·복수·충족 불가 범위의 416은 DELTA-01 단위 2 suites/45 tests, PostgreSQL L1 2 suites/167 tests에서 확인했다. 인증·PUBLIC content/download의 206 bytes·길이·`Content-Range`·파일 ID/revision 및 파일 교체 경합, 암호화 파일과 FILE/TREE snapshot의 206 식별자는 DELTA-02 단위 4 suites/90 tests와 PostgreSQL L1 3 suites/174 tests에서 확인했다. 인증 PRIVATE 파일의 빈 파일 및 `start == size` 416 응답은 PostgreSQL `public-fs.integration-spec.ts`에서 `Content-Range`와 기존 오류 envelope를 확인했다. 다섯 GET operation의 OpenAPI 206/416 헤더, 기존 416 JSON error schema/code, 공통 Range 설명은 `route-coverage.spec.ts` 12/12와 `error-contract.spec.ts` 5/5로 확인했다. 최종 `pnpm test`는 API 88 suites/872 tests, demo1-was 15/73, demo1-web 7/39 통과했고 typecheck·lint·build가 모두 통과했다(lint는 기존 demo1-web 경고 4건, 오류 0건). PostgreSQL L2는 33 suites/495 tests, SQLite L2는 19 suites/287 tests 통과했다. 206은 전체 파일 `X-Storix-Sha256`을 제공하지 않는다. 배포·외부 소비자·운영 proxy/storage 검증은 수행하지 않았다. SQLite 계약 검증에서 `range-content`(시작-끝·열린 끝·suffix·끝을 넘는 범위의 206이 지정 바이트·`Content-Length`·`Content-Range`·파일 ID·revision과 일치하고, 잘못된 문법·복수 범위·충족 불가 범위는 416)가 통과했다. 계약은 snapshot content·공개 경로·`/fs/download`·암호화 파일의 Range를 다루지 않는다.
- 호출자는 전체 파일을 받지 않고 byte range로 콘텐츠 일부를 조회할 수 있어야 한다. 부분 응답은 해당 바이트가 속한 안정 파일 ID와 revision을 식별할 수 있어야 한다. 전체 파일 SHA-256은 부분 응답의 검증값으로 사용하지 않는다.
- **수용 조건:** 단일 byte range의 시작-끝, 열린 끝, suffix 요청은 지정 구간의 바이트와 길이, `Content-Range`를 일치시켜 반환한다. 범위를 처리할 수 없는 요청은 `416`으로 거부한다. 파일 `206`에는 파일 ID와 revision이 포함되며, 전체 SHA-256 헤더의 의미를 부분 바이트 해시로 바꾸지 않는다.
- **관련 계약:** `GET /api/v2/namespaces/{namespaceId}/fs/content`, `/fs/download`, 공개 콘텐츠·다운로드 경로, snapshot 콘텐츠 경로의 `Range` / `206` / `416` 응답.

### RQ-022 디렉터리 자식 목록과 cursor 일관성

- [ ] **진행 상태:** 진행 중
- **판정 근거:** OpenAPI는 `GET /api/v2/namespaces/{namespaceId}/fs/ls`의 cursor pagination과 `consistency=revision`을 공개한다. 디렉터리 변경 후 기존 revision-bound cursor를 어떻게 거부하는지는 공개 계약에 명시되지 않았다. 이 항목은 해당 갭을 기록하며 runtime 동작 검증은 아니다. SQLite 계약 검증에서 `ls-pagination`(cursor 페이지가 누락·중복 없이 열거되고, revision 열거의 모든 페이지가 현재 `directoryRevision`을 알리며, 디렉터리 변경 뒤 이전 cursor로 다음 페이지를 이어 붙이지 않고 거부하고, 형식이 잘못된 cursor는 400 `VFS_INVALID_CURSOR`)이 통과했다. 변경 뒤 거부의 실제 응답은 412 `VFS_PRECONDITION_FAILED`로 openapi와 일치하지만 이 RQ의 수용 조건(400 `VFS_INVALID_CURSOR`)과 다르다. 계약은 두 응답 중 하나를 허용해 거부 사실만 단언하며, 어느 쪽으로 고정할지는 결정 대기 중이다.
- 호출자는 디렉터리의 직계 자식을 cursor 페이지로 열거할 수 있어야 한다. `consistency=revision`을 선택한 열거는 한 디렉터리 revision에 일관되어야 한다.
- **수용 조건:** cursor가 묶인 디렉터리 revision이 더 이상 현재 revision과 다르면 다음 페이지는 `400 VFS_INVALID_CURSOR`로 거부한다. 호출자는 첫 페이지부터 다시 열거하며, 서로 다른 디렉터리 상태의 페이지를 조용히 이어 붙이지 않는다.
- **관련 계약:** `GET /api/v2/namespaces/{namespaceId}/fs/ls`, `cursor`, `consistency=revision`, `rc1.` cursor 및 `directoryRevision`.

### RQ-023 디렉터리 생성

- [ ] **진행 상태:** 진행 중
- **판정 근거:** OpenAPI는 `/fs/mkdir`에서 이미 존재하는 디렉터리를 멱등 성공으로 응답하고, 조건부 `/fs/mutations`의 mkdir은 부재 조건을 사용한다. 부모 자동 생성은 공통 경로 계약상 명시적 옵션에 달려 있다. 이 RQ는 두 공개 계약의 동작을 추적하며 자동 검증 상태를 새로 주장하지 않는다. SQLite 계약 검증에서 `mkdir-parents`(`parents` 생략·false는 404이고 부모를 만들지 않음, `parents=true`는 부모와 대상을 함께 만들고 이미 있는 디렉터리의 재요청은 200으로 같은 ID·상태, 경로 중간이 파일이면 409, 조건부 mkdir은 기존 대상 412·없는 부모 404)와 `destination-parents`(이동·복사의 `destinationParents`)가 통과했다. `parents` 없는 `/fs/mkdir`가 이미 있는 디렉터리에 409 `VFS_ALREADY_EXISTS`를 반환하는 동작은 수용 조건(기존 디렉터리 재요청은 멱등 성공)·openapi(200)와 다르며, 계약은 이 경우를 단언하지 않는다(결정 대기 중).
- 호출자는 기존 디렉터리를 중복 생성하지 않고 필요한 경로에 디렉터리를 만들 수 있어야 한다. 없는 부모를 자동 생성할지는 요청에서 명시해야 한다.
- **수용 조건:** 기존 디렉터리 생성 재요청은 기존 디렉터리 ID와 상태를 보존하는 멱등 성공이다. `parents` 또는 `destinationParents`를 생략하거나 false로 두면 부모 디렉터리를 암묵적으로 만들지 않는다. true인 경우 부모 생성과 대상 생성은 모두 적용되거나 모두 적용되지 않는다.
- **관련 계약:** `POST /api/v2/namespaces/{namespaceId}/fs/mkdir`, `/fs/mutations`의 `kind: mkdir`, 공통 `parents` 규칙.

### RQ-024 파일·디렉터리 삭제

- [x] **진행 상태:** 로컬 구현·공개 계약·자동 검증 완료
- **판정 근거:** namespace별 기본 OFF 정책과 관리자 변경 API를 추가했다. ON 삭제는 기존 manifest 계약을 유지하고 OFF 삭제는 manifest 없이 영구 삭제하며 live byte·Blob 참조·change feed를 갱신한다. OFF 전환 전 생성된 trash item은 계속 목록·복원할 수 있고 조건부 receipt는 정책 전환 뒤에도 최초 응답을 재생한다. PostgreSQL·SQLite focused shared HTTP 테스트는 삭제·복구·receipt, snapshot 독립성, quota·Blob 참조를 확인한다. 이번 작업의 L1 race/receipt/audit 및 OpenAPI 근거는 `_works/20260928-02-vfs-trash-opt-out/DELTA-03.md`에 기록한다. 운영 DB migration, 실제 백업 복원, 외부 consumer/browser/production 연동은 이 판정에 포함하지 않는다. SQLite 계약 검증에서 `delete-conditional`(오래된 revision 412·무변경, 정상 삭제, 재생성 파일의 새 ID, 삭제 뒤 snapshot 보존, 비재귀 삭제의 409 `VFS_DIRECTORY_NOT_EMPTY`, 오래된 디렉터리 revision 412, 재귀 삭제의 하위 전체 제거)와 `delete-limit-rejection`(삭제 노드 수 상한 초과 413 `VFS_DELETE_LIMIT_EXCEEDED`, 트리 무변경)이 통과했다. 계약은 휴지통 ON, 보존 node 상한, 복구·purge를 다루지 않는다.
- 호출자는 파일과 디렉터리를 삭제할 수 있어야 한다. 조건부 삭제는 현재 대상 revision을 확인해야 한다. 재귀 삭제는 subtree 전체를 한 연산으로 처리해야 한다. 삭제된 경로를 다시 생성한 파일은 이전 파일과 다른 ID를 가진다. snapshot은 원본 파일 삭제와 독립적으로 보존된다.
- **수용 조건:** revision 불일치, 비재귀 삭제 대상 디렉터리의 자식 존재, 삭제 상한 초과, 활성 휴지통의 보존 node 상한 초과는 저장 상태를 바꾸지 않는다. ON 재귀 삭제는 subtree 전체를 하나의 복구 가능한 manifest로 이동하거나 아무것도 이동하지 않는다. OFF 삭제는 manifest 없이 원자적으로 제거한다. 같은 경로의 재생성은 새 파일 ID를 받고, 이미 생성한 snapshot은 명시적으로 삭제하기 전까지 읽을 수 있다.
- 휴지통 정책은 namespace별이며 기본 OFF다. 관리자는 별도 admin key와 `Idempotency-Key`가 있는 PATCH로 변경하고 namespace 응답에서 값을 조회한다. 정책 변경과 삭제는 같은 namespace root mutation lock 아래 직렬화된다. ON 삭제는 live byte를 trash byte로 옮겨 만료 뒤에도 purge commit까지 quota에 포함한다. OFF 삭제는 live byte와 live Blob reference를 감소시킨다. 기존 trash item은 OFF 전환 뒤에도 목록·복원·purge 가능하며, 복원은 원래 ID와 새 revision으로 live quota/Blob 참조를 회복한다.
- 휴지통 항목은 원래 ID·revision·상대 경로·Blob metadata를 30일간 보존한다. `STORIX_MAX_RETAINED_TRASH_NODES`는 namespace당 기본 100000개이며 양의 안전 정수만 허용한다. 직접 purge는 관리자 key와 receipt가 필요하며, GC는 `expiresAt <= DB now` 후보를 제한된 배치로 같은 purge 경로에 전달한다. Purge는 다른 live·snapshot·trash Blob 참조를 보존한다. 삭제와 복구는 change feed에 각각 `deleted`·`created`를 남기고 목록·purge는 파일 변경 이벤트를 만들지 않는다. 조건부 delete receipt는 정책 전환 뒤에도 최초 결과를 재생한다. OFF 삭제 응답 및 감사 row에는 trash ID가 없다.
- **관련 계약:** `POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 `kind: delete`, `/fs/rm`, `/fs/rmdir`, `/fs/trash` 목록·복구·purge, snapshot content/read/delete 경로 및 [휴지통 설계](../design/09-vfs-trash-and-recovery.md).

### RQ-025 파일·디렉터리 이동

- [ ] **진행 상태:** 진행 중
- **판정 근거:** OpenAPI는 조건부 `/fs/mutations` 및 `/fs/mv`를 공개하고 조건부 경로에는 source revision, destination 부재, 명시적 exact 해석을 표현한다. ID·revision 및 실패 시 subtree 보존 요구와 일부 목적지 의미는 추가로 정합화할 필요가 있다. runtime 동작은 이 항목에서 재검증하지 않는다. SQLite 계약 검증에서 `move-subtree`(하위 전체 이동, ID·바이트 유지, affected revision이 이동 뒤 revision과 일치, exact 생략 시 기존 디렉터리 아래 배치), `move-rejection`(자기 subtree 409 `VFS_INVALID_OPERATION`, 오래된 revision·목적지 충돌 412, 없는 원본·부모 404, 잘못된 경로 400, 모두 무변경), `destination-parents`가 통과했다.
- 이동은 동일 노드와 subtree를 다른 경로에 배치하는 연산이다. 이동한 노드와 하위 노드의 ID는 유지하고 경로 및 영향받은 revision은 갱신한다. 목적지가 기존 디렉터리면 기본 동작은 그 아래 원본 basename을 배치한다. `exact`는 지정 경로 자체가 비어 있어야 한다는 뜻이다.
- **수용 조건:** 자기 자신 또는 자기 subtree로 디렉터리를 옮길 수 없다. revision 불일치, 목적지 충돌, 경로 오류 또는 연산 실패 시 원본과 목적지 트리는 모두 변경되지 않는다. 성공하면 subtree 전체가 이동되고 안정 ID는 유지되며 affected revision은 새 상태를 가리킨다. 없는 부모는 `destinationParents: true`로 명시할 때만 함께 만든다.
- **관련 계약:** `POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 `kind: move`·`destinationResolution`, `/fs/mv`.

### RQ-026 파일·디렉터리 복사

- [ ] **진행 상태:** 진행 중
- **판정 근거:** OpenAPI는 조건부 `/fs/mutations` 및 `/fs/cp`, destination 부재 조건, copy Node 수 상한을 공개한다. 새 정체성, 독립 변경 및 snapshot 이력 비복제는 요구사항으로 명시되지만 이 항목에서 구현 검증을 주장하지 않는다. SQLite 계약 검증에서 `copy-subtree`(새 ID로 구조·바이트 복제, 원본 무변경, 원본·복사본 독립 변경, 원본 snapshot 이력 비복제), `copy-rejection`(자기 subtree 409, 오래된 revision·목적지 충돌 412, 없는 원본·부모 404, 잘못된 경로 400, 부분 트리 없음), `copy-limit-rejection`(노드 수 상한 초과 413 `VFS_COPY_LIMIT_EXCEEDED`, 목적지 미생성), `destination-parents`가 통과했다.
- 복사는 현재 파일·디렉터리 subtree를 새 자원으로 만든다. 복사본은 새 ID와 revision을 가지며 원본의 현재 구조와 파일 바이트를 보존한다. 원본 snapshot 이력은 복제하지 않는다.
- **수용 조건:** 목적지 충돌, 상한 초과, 경로 오류 또는 연산 실패 시 부분 subtree가 남지 않는다. 성공한 복사본의 경로·구조·바이트는 연산 시점 원본과 같고 Node ID는 새 값이다. 이후 원본과 복사본 각각의 콘텐츠 변경은 다른 쪽에 영향을 주지 않는다. 없는 부모는 `destinationParents: true`로 명시할 때만 함께 만든다.
- **관련 계약:** `POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 `kind: copy`, `/fs/cp`.

### RQ-027 선택 capability의 설정과 검색

- [x] **진행 상태:** PostgreSQL 및 SQLite 로컬 코드·자동 검증 완료
- **판정 근거:** 시작 JSON 설정과 namespace 존재 검증, 정적 registry·전역/namespace 활성 판정·의존성 검증, 409 `VFS_FEATURE_DISABLED`와 조건부 receipt 경계가 구현되어 있다. `GET /api/v2/namespaces/{id}/capabilities`는 서비스 Bearer 인증 아래 ACTIVE namespace의 실제 활성 선택 ID(의존 ID 포함)를 사전순으로 반환하며 빈 registry에서는 빈 배열을 반환한다. 설정 환경 변수와 조회 계약은 README·`.env.example`·OpenAPI에 공개되어 있다. PostgreSQL과 SQLite 통합 검증에서 `resumable-upload`로 파일을 완료한 뒤 비활성 설정으로 재시작하고, capability 목록에서 ID가 빠진 상태에서도 기존 VFS `stat` 및 `content` API가 동일한 파일 ID·revision·바이트를 반환함을 확인했다. 운영 배포 설정과 별도 실소비자 검증은 포함하지 않는다. 상세 설계는 [VFS capability 설계](../design/06-vfs-capabilities.md)를 참고한다. SQLite 계약 검증에서 `capability-default-off`(설정 없이는 활성 목록이 비어 있고 feed 요청이 409 `VFS_FEATURE_DISABLED`이며 파일 API는 동작)와 `capability-discovery`(전역과 namespace에 허용한 namespace만 `["change-feed"]`를 조회하고 feed가 열리며, 허용하지 않은 namespace는 빈 목록·409·파일 API 동작)가 통과했다. 계약은 `resumable-upload`, 설정 변경 재시작 뒤 기존 데이터 보존, 미등록 ID·잘못된 설정 파일의 시작 거부를 다루지 않는다.
- 기존 파일 API는 기본 활성으로 유지하며 VFS-01에서 기존 연산을 끄는 설정은 도입하지 않는다. 이후 추가되는 선택 기능은 관련 endpoint를 완결된 capability 단위로 묶어 설정할 수 있어야 한다. 전역 설정은 상위 차단으로 작동하고 namespace 설정은 전역에서 허용한 기능만 제한하거나 허용한다. 전역 차단을 namespace 설정으로 다시 켤 수 없다. 새 선택 기능은 명시적으로 활성화하기 전까지 비활성이다.
- 기능 비활성화는 그 기능이 이미 저장한 데이터를 삭제하거나 감추지 않는다. 기존 데이터의 안전한 조회·내보내기·복구·삭제는 계속 가능해야 한다. 비활성 기능 요청은 안정적인 `VFS_FEATURE_DISABLED` 오류로 거부하고 소비자는 활성 capability 조회 API로 활성 ID를 확인할 수 있다.
- 설정은 서비스 시작 시 적용한다. 각 capability 요구사항은 적용 범위, 기본값, 전역/namespace 우선순위, 의존성, 비활성 응답, 기존 데이터 처리, 조회 노출을 명시한다. 운영 중 설정 변경은 현재 제공하지 않는다. 조회 API는 설정 snapshot의 실제 활성 ID만 반환한다.
- **수용 조건:** 새 선택 기능이 capability 경계 밖으로 부분 활성화되지 않고, namespace 설정으로 전역 차단을 우회할 수 없다. 비활성화 뒤에도 기존 데이터 보존 조건을 지키며, 소비자는 안정된 오류 코드와 활성 상태 조회로 비활성 이유를 판별할 수 있다.

### RQ-028 업로드 전체 checksum 검증

- [x] **진행 상태:** 로컬 코드·자동 검증 완료
- **판정 근거:** raw 조건부 업로드와 재개 업로드에 checksum 입력·평문 SHA-256 비교·불일치 보존 결과가 구현됐다. DELTA-01 raw 집중 검증과 DELTA-02 PostgreSQL 2 suites/23 tests, SQLite 3 suites/41 tests의 선택 L1 근거가 있다. 마지막 기존 파일 보존 단언 보강 뒤 `upload-session-finalize.integration-spec.ts`와 SQLite 대응 spec을 각각 20/20 통과했다. 최종 L0는 통과했다. 최종 PostgreSQL L2는 33 suites/485 tests, SQLite L2는 19 suites/286 tests 통과했다. 최초 PostgreSQL 전체 실행 중 기존 short-lease 사례 1건이 400으로 실패했으나 단독·파일 전체 재실행에서는 재현되지 않았고, 후속 전체 L2는 통과했다. 원인은 특정하지 않았다. 운영 배포 활성화와 소비자 연동은 검증 범위에서 제외한다. SQLite 계약 검증에서 `upload-checksum`(정상 checksum 저장, 불일치 422 `VFS_CHECKSUM_MISMATCH`의 기존 파일·revision 유지와 기대값·계산값 비노출, 같은 key 재전송의 최초 422 재생, 새 경로 미생성, 대문자·짧은 값 등 형식 오류 400 `VFS_INVALID_CHECKSUM`)이 통과했다. 계약은 ENCRYPTED namespace와 재개 업로드(capability 기본 비활성)를 다루지 않는다.
- 호출자는 raw 조건부 업로드의 선택적 `X-Content-Sha256` 또는 재개 업로드 세션 생성의 선택적 `sha256`으로 전체 파일의 SHA-256을 지정할 수 있어야 한다. 값은 정확히 64자리 소문자 hex이며 ENCRYPTED namespace도 저장 전 평문 바이트를 기준으로 한다. checksum을 생략한 기존 요청은 계속 처리한다.
- 잘못된 표현은 raw 본문 소비·receipt 생성 또는 재개 세션 생성 전에 `400 VFS_INVALID_CHECKSUM`으로 거부해야 한다. 계산값과 다르면 `422 VFS_CHECKSUM_MISMATCH`이며 파일 바이트·revision을 바꾸거나 기대값·계산값을 노출해서는 안 된다.
- raw의 422 receipt는 본문 해시와 기대 checksum에 결합해 동일 key의 동일 요청에서 재생한다. 재개 생성 fingerprint도 checksum에 결합한다. 재개 완료 불일치는 `FAILED`와 최초 422 결과를 보존해 반복 완료에서 재생하고, 상태 조회는 `failure.code`만 공개한다. 실패 세션 결과는 종결 뒤 최소 30일 보존하며, staging 객체는 삭제 확인 전까지 임시 사용량에 포함한다.
- **수용 조건:** 평문·ENCRYPTED namespace에서 정상 checksum은 완료되고 불일치는 기존 파일·revision을 유지한다. malformed 입력, key 재사용·결과 재생, FAILED 상태 조회, 30일 보존과 조각 정리·사용량 회계를 PostgreSQL 및 SQLite 검증에서 확인한다.

### RQ-029 namespace 변경 feed

- [x] **진행 상태:** 구현·공개 계약 및 PostgreSQL/SQLite 로컬 검증 완료
- **판정 근거:** `GET /api/v2/namespaces/{namespaceId}/fs/changes`, namespace별 journal·checkpoint·cursor·GC와 OpenAPI 계약을 PostgreSQL·SQLite L1/L2에서 확인했다. PostgreSQL 전체 L2 첫 실행은 36 suites/514 tests 중 34 suites/504 tests 통과, VFS node·receipt 2 suites 실패였다. 하위 시작 디렉터리 ID 회귀를 수정한 뒤 실패 suite 2개를 재실행해 131/131 통과했다. receipt의 retry-after 60초 기대값이 첫 실행에서 61초로 나온 1회성 차이는 재실행에서 재현되지 않았다. SQLite L2는 22 suites/307 tests, API unit은 88 suites/875 tests 통과했고 typecheck·lint·build도 통과했다. 실제 운영 활성화, 소비자 동기화 및 production 복구는 확인하지 않았다. SQLite 계약 검증(프로필 `change-feed`)에서 `change-feed-replay`(cursor 없는 호출의 빈 checkpoint, 생성·교체·이동·삭제의 sequence 오름차순 재생과 moved의 `previousPath`·deleted의 마지막 경로·live 이벤트의 `revision`, `operationId`별 `operationIndex`·`operationCount` 일관성, 같은 cursor의 재조회와 limit 분할 재조회 동일, 빈 페이지의 cursor 유지, 재시작 뒤 재생 동일), `change-feed-subtree`(subtree 복사·이동·재귀 삭제의 노드별 이벤트, snapshot 생성·조회·목록·삭제의 무이벤트, 복원의 `updated`), `change-feed-cursor-errors`(잘못된·변조된·다른 namespace cursor의 400 `VFS_INVALID_CURSOR`)가 통과했다. 부모·루트 디렉터리의 `updated` 이벤트도 함께 기록된다. 계약은 410 `VFS_CHANGE_CURSOR_EXPIRED`, GC, 초기 checkpoint와 mutation 경합, capability off/on 전환, net 이벤트 병합, namespace 삭제 정리를 다루지 않는다.
- 호출자는 cursor 없이 먼저 checkpoint를 발급받고 기존 `ls` API로 namespace 전체를 열거한 뒤 checkpoint 이후의 변경을 재생할 수 있어야 한다. 열거 중 목록 cursor가 무효화되면 checkpoint를 보존하고 열거를 다시 시작한다. 기존 파일 바이트 이력은 feed가 제공하지 않으며 변경된 파일의 현재 상태를 다시 읽는다.
- 성공한 파일·디렉터리 mutation과 journal 항목은 같은 DB transaction에서 확정된다. namespace별 `sequence`는 커밋 순서로 증가하며 한 transaction의 같은 노드는 최초·최종 상태를 비교해 net 이벤트 하나만 낸다. 이벤트는 `created`·`updated`·`moved`·`deleted`이며 이동의 이전 경로와 삭제의 마지막 경로를 제공한다. subtree 이동·복사·재귀 삭제는 영향받은 노드별로 기록하고 snapshot 생성·목록·삭제는 제외한다. snapshot 복원으로 파일이 바뀌면 `updated`를 기록한다.
- 각 이벤트의 `operationId`·`operationIndex`·`operationCount`는 같은 transaction의 항목을 묶는다. 페이지는 transaction 중간에서 끝날 수 있다. 소비자는 응답 변경의 적용과 `nextCursor` 저장을 원자적으로 수행하고, 재조회 시 `sequence`로 중복을 제거한다. 빈 페이지의 cursor는 polling에 재사용한다. 기본 limit는 100, 최대는 1000이며 `hasMore`는 조회 시점의 다음 페이지 존재 여부다.
- 잘못되거나 다른 namespace의 cursor는 400 `VFS_INVALID_CURSOR`, 보존 경계 이전 cursor는 410 `VFS_CHANGE_CURSOR_EXPIRED`다. 만료 시 새 checkpoint를 발급받아 전체 열거부터 재동기화한다. `change-feed` capability는 기본 비활성이며 비활성 요청은 409 `VFS_FEATURE_DISABLED`다. 최초 checkpoint 뒤에는 capability가 꺼져도 journal 기록을 계속해 재활성화 후 보존 기간 안의 cursor를 유지한다. 기본 보존 기간은 30일이고 GC는 DB 시각으로 오래된 이벤트와 경계를 같은 transaction에서 정리한다.
- **수용 조건:** PostgreSQL·SQLite에서 초기 checkpoint와 mutation 경합에도 열거와 재생 사이 변경이 누락되지 않는다. 성공·롤백·다중 연산의 net 이벤트, subtree tombstone, operation metadata, 페이지 재조회·polling, capability off/on, cursor 오류·만료, GC/page 경합과 namespace 삭제 정리를 검증한다.
- **관련 계약:** [변경 feed 설계](../design/08-namespace-change-feed.md), `GET /api/v2/namespaces/{namespaceId}/fs/changes`, `GET /api/v2/namespaces/{namespaceId}/fs/ls`, `STORIX_VFS_CHANGE_RETENTION_DAYS`.

## 소비자 어댑터 책임과 범위 제외

- 최종 사용자 인증, 프로젝트 ACL, 사용자·프로젝트와 namespace의 연결, 허용 경로 결정은 호출 서버 책임이다.
- 소비자별 파일 파싱·검증, 입력 정규화 여부, 최종 사용자에게 보여줄 오류 문구는 소비자 어댑터 책임이다. Storix는 JSON이 아닌 파일도 저장할 수 있어야 한다.
- Jupyter 어댑터에서는 `nbformat` 지원 범위, Jupyter Contents API 경로·상태 코드·응답 모양, 체크포인트 응답 변환과 WAS 자체 응답 재생을 어댑터가 책임진다.
- 셀 실행, 커널 관리, 렌더링, 셀 단위 병합, 노트북 신뢰 서명은 Storix 범위에서 제외한다.

## 관련 문서

- [소비자 요구와 Storix 계약](../design/03-consumer-contracts.md): 범용 저장 기능과 호출 서버 어댑터의 책임.
- [Storix 로드맵](../ROADMAP.md): 실행 항목과 이 문서의 RQ ID 연결.
- [Storix OpenAPI](../../apps/api/openapi.yaml): 현재 제공하는 HTTP 계약.
