# Storix 범용 파일 저장 요구사항

## 목적과 범위

이 문서는 **범용 저장 계약**과 수용 조건을 정의한다.
특정 편집기·언어·파일 형식에 종속되지 않는다.
Jupyter Notebook은 소비자 사례 중 하나다.

| 담당                    | 범위                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Storix                  | 호출 서버가 지정한 namespace의 파일·디렉터리·바이트·메타데이터·revision·snapshot 관리 |
| 호출 서버·소비자 어댑터 | 최종 사용자 인증·소비자별 권한·파일 파싱과 검증·소비자 응답 형식                      |
| Jupyter 어댑터          | 노트북 JSON·`nbformat` 정책·Jupyter Contents API 응답                                 |

- Storix는 허용된 파일 바이트를 재해석하거나 정규화하지 않는다.
- 요구사항에서 지정하지 않은 구현 방식은 제한하지 않는다.
- HTTP 경로·DB 구조·오브젝트 저장 방식도 이 원칙을 따른다.

## 용어와 진행 상태

| 용어        | 의미                                                         |
| ----------- | ------------------------------------------------------------ |
| namespace   | Storix가 관리하는 독립 파일 공간                             |
| 파일 ID     | 이름·경로 변경 후에도 같은 파일을 구분하는 식별자            |
| revision    | 파일 상태 변경을 구분하는 불투명한 식별자                    |
| 콘텐츠 해시 | 전체 조회에서 반환하는 파일 바이트의 SHA-256                 |
| 스냅샷      | 생성 시점의 파일 바이트·메타데이터를 보존하는 불변 저장 기록 |
| capability  | 소비자 사용 사례 하나를 완성하는 선택 기능 묶음              |

용어별 규칙:

- 호출 서버는 자체 권한 판단 후 namespace를 선택한다.
- 삭제 후 같은 경로에 만든 파일에는 새 ID를 부여한다.
- revision은 동등성 비교에만 사용한다.
- revision의 내용·숫자 순서를 해석하지 않는다.
- 콘텐츠 해시와 revision은 용도가 다르다.
- 스냅샷은 체크포인트·복구 지점으로 사용할 수 있다.
- capability의 관련 연산은 함께 설정한다.
- 일부 연산만 활성화해 사용 사례를 완성할 수 없는 상태를 만들지 않는다.

상태 판정:

- 진행 상태는 `미착수`·`진행 중`·`검증 완료`·`보류`로 구분한다.
- 공개 계약·코드·자동 검증·배포 및 소비자 검증 근거를 구분한다.
- 공개 계약만 대조한 항목은 `검증 완료`로 표시하지 않는다.
- 수용 조건에 갭이 남은 항목도 `검증 완료`로 표시하지 않는다.
- `[x]`는 공개 계약·코드·자동 검증 근거로 수용 조건을 확인한 항목이다.
- `[ ]`는 갭 또는 필요한 검증이 남은 항목이다.
- 배포 환경·특정 소비자 연동은 별도로 검증한다.
- 요구사항·구현이 바뀌면 같은 변경에서 RQ 상태와 판정 근거를 갱신한다.
- `RQ-NNN`은 요구사항 ID다.
- [ROADMAP](../ROADMAP.md)의 실행 항목 ID와 구분한다.

판정 근거의 실행 결과는 기존 검증 기록이다.
이번 문서 편집에서 다시 실행한 결과를 뜻하지 않는다.

## 1. 호출과 격리

### RQ-001 호출 서버 인증

- [x] **진행 상태:** 검증 완료

**요구사항:**

- Storix는 보호 대상 읽기·쓰기 요청에서 호출 서버의 자격을 검증해야 한다.
- 자격이 없거나 유효하지 않으면 요청을 거부해야 한다.
- 거부 시 파일 존재 여부·본문을 노출하지 않아야 한다.
- 최종 사용자 인증 결과를 Storix가 직접 판단할 필요는 없다.
- 호출자가 보낸 최종 사용자 식별값은 감사 정보로 사용할 수 있다.
- 그 값만으로 권한을 부여해서는 안 된다.

**수용 조건:**

- 같은 요청에 대해 유효한 서비스 자격은 허용되고, 누락·오류 자격은 거부된다.

**판정 근거:**

- 전역 API 키 가드와 인증 단위 테스트에서 유효·누락·오류 자격을 확인했다.
- SQLite 계약 검증(`pnpm contract`)에서 `api-key-required`가 통과했다.
  - 누락·오류·비Bearer 자격의 401.
  - 존재 여부·본문 미노출.
  - 인증 없는 변경 거부.
- `public-namespace-boundary`가 공개 경로의 인증 예외 범위를 확인했다.
  - PUBLIC namespace의 인증 경로 조회·변경도 자격이 없으면 401 `UNAUTHORIZED`.
  - 인증 없는 변경은 미적용.
  - 공개 경로는 읽기 두 route뿐이고 목록·메타데이터·쓰기 route는 404.

### RQ-002 namespace 격리

- [x] **진행 상태:** 검증 완료

**요구사항:**

- 모든 파일·스냅샷 요청은 namespace를 명시해야 한다.
- 파일 ID, 경로, 스냅샷 ID가 같거나 비슷해도 다른 namespace의 자원을 조회·변경할 수 없어야 한다.

**수용 조건:**

- namespace A에서 얻은 식별자로 namespace B의 파일·스냅샷을 읽거나 변경할 수 없다.

**판정 근거:**

- 파일·스냅샷 조회와 변경이 namespace로 제한되며, 다른 namespace 스냅샷 복원 거부 사례를 확인했다.
- SQLite 계약 검증에서 `namespace-isolation`이 통과했다.
  - 같은 경로의 독립 파일.
  - 다른 namespace의 revision·snapshot ID로 조회·복원 거부.
  - 삭제의 격리.
- `public-namespace-boundary`는 PRIVATE namespace·없는 namespace·UUID가 아닌 ID의 공개 조회가 같은 404 `NAMESPACE_NOT_FOUND`(상태·본문 모양 동일)라 존재 여부를 알 수 없음을 확인했다.
- `upload-session-lifecycle`은 다른 namespace의 세션 조회·조각 추가·완료·취소가 없는 세션과 같은 404 `VFS_UPLOAD_SESSION_NOT_FOUND`이고 원래 세션이 그대로 `OPEN`임을 확인했다.
  - `resumable-upload` 프로필.

### RQ-003 경로 계약

- [x] **진행 상태:** 로컬 코드·통합 검증 완료

**요구사항:**

- Storix는 경로의 절대·상대 여부, 구분자, 정규화, 허용 문자, 최대 길이, `..` 처리와 디렉터리 부모 생성 여부를 공개 계약으로 정의해야 한다.
- 같은 의미의 경로가 서로 다른 파일을 뜻하거나, 경로 해석으로 namespace 밖에 접근해서는 안 된다.

**수용 조건:**

- 정상 경로는 일관된 정규 경로로 식별되고, 허용하지 않는 경로는 저장 변경 없이 명시적으로 거부된다.

**판정 근거:**

- `/api/v2`의 파일·snapshot 경로에 공통 절대경로·NFC·허용 문자·UTF-8 이름 255바이트·정규 절대경로 4096바이트 상한을 적용했다.
- TREE 내부 상대경로와 이동·복사 결과·하위 경로에도 같은 한도를 적용하며, 경로 오류는 400 `VFS_INVALID_PATH`로 거부한다.
- API 단위 테스트 76 suites/674 tests, 인증 파일 HTTP L1 1 suite/139 tests, 공개 파일 HTTP L1 1 suite/11 tests, PostgreSQL L2 27 suites/410 tests, SQLite L2 12 suites/213 tests가 기록된 검증에서 통과했다.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`도 exit 0이다.
- 실제 사용처 배포·전용 인스턴스 초기화·데이터 복구 검증은 수행하지 않았다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `path-normalization`:
    - 중복 구분자·`.`·끝 `/` 정규화.
    - 대소문자·NFC 이름 보존.
  - `path-rejection`:
    - `..`·상대경로·백슬래시·제어·Bidi 문자·NFD·이름 255바이트 초과·경로 4096바이트 초과의 400 `VFS_INVALID_PATH`와 트리 무변경.
    - 부모 자동 생성 없음.
- `public-namespace-read`는 공개 경로에도 같은 경로 계약(상위 이동·상대 경로·경로 누락은 400 `VFS_INVALID_PATH`)이 적용됨을 확인했다.

## 2. 파일 생성·조회·변경

### RQ-004 바이트 무손실 보존

- [x] **진행 상태:** 검증 완료

**요구사항:**

- Storix는 파일 형식과 무관하게 전달받은 바이트를 보존하고 전체 조회에서 동일하게 반환해야 한다.
- JSON, 노트북, 이미지나 임의 바이너리 등 콘텐츠 의미를 해석하거나 정규화하지 않는다.

**수용 조건:**

- 서로 다른 바이트열을 각각 저장·조회했을 때 입력과 출력의 바이트 및 전체 SHA-256이 일치한다.

**판정 근거:**

- 원시 바이트 스트림 저장·조회와 바이너리 왕복 검증으로 본문 변환이 없음을 확인했다.
- SQLite 계약 검증에서 `byte-roundtrip`이 통과했다.
  - 빈 파일.
  - 0x00~0xff.
  - BOM.
  - 혼합 개행.
  - 비UTF-8.
  - 1MiB 무작위를 조건부·무조건 저장 경로 모두로 왕복.
  - 바이트·SHA-256·크기 일치.
- `upload-session-complete`는 조각을 나눠 올린 파일의 바이트·크기·SHA-256이 원본과 같음을 확인했다.
  - `resumable-upload` 프로필.

### RQ-005 존재하지 않는 파일의 조건부 생성

- [x] **진행 상태:** 로컬 코드·통합 검증 완료

**요구사항:**

- 호출자는 지정 경로에 파일이 없을 때만 전체 바이트를 생성할 수 있어야 한다.
- 이미 파일이 있으면 기존 파일을 보존하고 충돌 오류를 반환해야 한다.
- 성공 결과에는 파일 ID, 정규 경로, revision, 수정 시각이 포함되어야 한다.

**수용 조건:**

- 같은 경로에 대한 동시 조건부 생성 두 건 중 최대 한 건만 성공하고, 성공한 파일의 바이트가 온전하다.

**판정 근거:**

- 조건부 콘텐츠 생성의 `resource.id`(VFS 노드 UUID)·정규 경로·`resource.revision`·수정 시각을 공개한다.
- PostgreSQL `fs.integration-spec.ts` L1 140/140에서 동시 생성의 단일 승자, receipt 재생, 이동·교체 시 ID 유지를 확인했다.
- 삭제·동일 경로 FILE 재생성 시 새 ID를 확인하는 단언은 전체 실행 뒤 보강했으며 해당 사례만 단독 1/1 통과했다.
- 최종 PostgreSQL L2의 파일 HTTP suite는 통과했고 SQLite L2는 12 suites/213 tests 통과했다.
- PostgreSQL L2 전체는 기존 412 repository 기대값의 `id` 누락으로 26 suites 통과·1 suite 실패했으며, 기대값 수정 뒤 해당 spec 114/114가 통과했다.
- SQLite 계약 검증(`pnpm contract`)에서 `conditional-create`와 `conditional-create-race` 2개가 통과했다.
  - `conditional-create`: 존재하는 경로의 412와 기존 바이트 보존.
  - `conditional-create-race`: 동시 생성의 단일 승자와 바이너리 무손실.
- `upload-session-complete`는 `ifAbsent` 세션의 완료 시점에 경로가 이미 있으면 412이고 기존 파일이 그대로임을 확인했다.
  - `resumable-upload` 프로필.

### RQ-006 전체 파일 조회

- [x] **진행 상태:** 로컬 코드·통합 검증 완료

**요구사항:**

- 호출자는 namespace와 경로로 현재 파일 전체를 읽을 수 있어야 한다.
- 조회 결과에는 반환한 바이트에 대응하는 파일 ID, revision, 콘텐츠 해시를 식별할 수단이 있어야 한다.
- 디렉터리와 파일 부재는 구분해야 한다.

**수용 조건:**

- 저장 직후와 Storix 재시작 후 조회한 바이트와 해당 revision·해시가 일관된다.

**판정 근거:**

- 인증된 전체 `GET /fs/content` 200의 `X-Storix-File-Id`·`X-Storix-Revision`·`X-Storix-Sha256`이 반환한 바이트와 같은 노드/Blob 상태를 식별한다.
- PostgreSQL `fs.integration-spec.ts` L1 141/141에서 저장·교체·재시작, stat 대조, 교체 경합을 확인했고, `encrypted-content.integration-spec.ts` L1 5/5에서 복호화 바이트의 해시를 확인했다.
- 최종 PostgreSQL L2는 관련 suite 통과, SQLite L2는 12 suites/213 tests 통과했다(전체 PostgreSQL L2의 기존 412 repository 기대값 실패는 수정 후 해당 spec 114/114 통과).
- Range 206에는 `X-Storix-File-Id`·`X-Storix-Revision`을 제공하며, 전체 파일의 `X-Storix-Sha256`은 제공하지 않는다.
- SQLite 계약 검증에서 `full-read-identity`가 통과했다.
  - 저장·교체 직후 헤더가 파일 ID·revision·SHA-256과 일치.
  - 디렉터리 409와 부재 404 구분.
- `restart-persistence`가 재시작 후 조회를 확인했다.
  - 재시작 전후로 바이트·`X-Storix-*` 헤더·stat이 같음.
- `public-namespace-read`이 공개 경로 조회를 확인했다.
  - PUBLIC namespace의 공개 경로 무인증 전체 조회·다운로드가 인증 경로와 같은 바이트.
  - 교체 뒤 새 바이트·revision.
  - 없는 파일 404 `VFS_NODE_NOT_FOUND`·디렉터리 409 `VFS_IS_DIRECTORY`.

### RQ-007 본문 없는 메타데이터 조회

- [x] **진행 상태:** 로컬 코드·통합 검증 완료

**요구사항:**

- 호출자는 파일 본문을 전송받지 않고 파일 ID, 정규 경로, 바이트 크기, MIME 유형, 마지막 수정 시각, 현재 revision, 콘텐츠 해시를 함께 조회할 수 있어야 한다.
- 해시는 Storix가 전체 조회에서 반환하는 정확한 바이트를 기준으로 계산해야 한다.

**수용 조건:**

- 메타데이터의 크기·해시는 같은 revision으로 조회한 전체 파일의 바이트 길이·SHA-256과 일치한다.

**판정 근거:**

- `GET /fs/stat`의 단일 응답에 노드 ID·정규 경로·크기·MIME·수정 시각·`revision`·`sha256`이 있으며 노드와 참조 Blob을 한 읽기 상태에서 조회한다.
- PostgreSQL `fs.integration-spec.ts` L1 140/140에서 전체 콘텐츠와 크기·SHA-256 일치, 빈 FILE 해시, DIRECTORY의 `sha256: null`, namespace 격리와 부재를 확인했다.
- 최종 PostgreSQL L2는 관련 suite 통과, SQLite L2는 12 suites/213 tests 통과했다.
- 기존 412 repository 기대값에 새 `id`가 없어 PostgreSQL L2의 한 suite가 실패했으며 기대값 수정 후 해당 spec 114/114 통과했다.
- SQLite 계약 검증에서 `stat-metadata`가 통과했다.
  - ID·경로·크기·MIME·revision·SHA-256이 전체 조회와 일치.
  - 빈 파일 해시.
  - 디렉터리 `sha256: null`.
  - 부재 404.

### RQ-008 revision 조건부 전체 교체

- [x] **진행 상태:** 검증 완료

**요구사항:**

- 호출자는 읽은 revision을 조건으로 파일 전체 바이트를 교체할 수 있어야 한다.
- 조건이 현재 revision과 다르면 충돌을 반환하고 파일 바이트·revision·수정 시각을 바꾸지 않아야 한다.
- 성공한 변경은 이전과 다른 revision을 반환해야 한다.

**수용 조건:**

- 같은 revision을 조건으로 한 두 교체 요청 중 최대 한 건만 성공한다.

**판정 근거:**

- 정확한 revision 조건의 전체 교체와 오래된 revision 충돌을 PostgreSQL 통합 사례로 확인했다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `revision-replace`:
    - 교체 시 revision 변경.
    - 오래된 revision의 412와 바이트·revision·수정 시각 유지.
  - `revision-replace-race`: 같은 revision 동시 교체 4건 중 1건만 성공.
- `upload-session-complete`는 `ifRevision` 세션의 완료 시점에 revision이 바뀌어 있으면 412이고 파일이 그대로임을 확인했다.
  - `resumable-upload` 프로필.

### RQ-009 원자적 파일 저장

- [x] **진행 상태:** 검증 완료

**요구사항:**

- 생성·교체·복원은 호출자에게 전부 적용되거나 전혀 적용되지 않은 결과로 관찰되어야 한다.
- 업로드 중단, 저장 장애, 한도 초과 시 이전 파일에 부분 바이트나 새 revision을 노출해서는 안 된다.
- 성공 응답의 revision과 수정 시각은 실제로 읽을 수 있는 완료 상태를 가리켜야 한다.

**수용 조건:**

- 실패 지점별 재조회에서 기존 파일과 revision이 유지되며, 성공 직후에는 새 파일 전체를 읽을 수 있다.

**판정 근거:**

- 업로드 중단·한도 초과 및 복원·스냅샷 receipt 실패의 롤백 사례를 PostgreSQL 통합 검증에서 확인했다.
- SQLite 계약 검증에서 `save-atomicity`가 통과했다.
  - checksum 불일치 422와 중단된 업로드 뒤 기존 파일·revision 유지.
  - 새 경로에 부분 파일 없음.
  - 같은 revision 재저장 성공.
- `upload-session-complete`도 확인했다.
  - `resumable-upload` 프로필: 완료 전 파일 미노출.
  - 모든 조각이 모인 완료에서 파일을 한 번에 공개.
  - 완료 파일의 바이트·크기·`X-Storix-Sha256`·revision 일치.
  - 완료 시점의 `ifAbsent`·`ifRevision` 불일치는 412이고 대상 파일이 그대로.
- 계약은 한도 초과 롤백과 복원·snapshot receipt 실패를 포함하지 않는다.

### RQ-010 순서와 재시작 후 지속성

- [x] **진행 상태:** 검증 완료

**요구사항:**

- 같은 파일에 대한 조건부 변경은 하나의 확정 순서를 가져야 하며, 성공 응답 이후 Storix 재시작으로 이미 완료된 파일·revision·스냅샷이 사라져서는 안 된다.
- 수정 시각과 revision은 동일한 확정 상태를 가리켜야 한다.

**수용 조건:**

- 동시 저장과 재시작을 포함한 시나리오에서 성공 결과를 다시 조회할 수 있고 조용한 마지막 쓰기 승리가 없다.

**판정 근거:**

- 동시 조건부 변경과 SQLite 스냅샷·파일·receipt 재시작 지속성을 통합 검증에서 확인했다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `concurrent-write-restart`:
    - 같은 revision의 동시 교체 4건 중 1건만 성공하고 재시작 뒤에도 승자의 바이트·revision 유지.
    - 옛 revision은 412.
  - `restart-persistence`:
    - 재시작 전후 파일 바이트·헤더·stat 일치.
    - 재시작 전후 디렉터리 일치.
    - 재시작 전후 snapshot 메타데이터·바이트·목록 일치.

## 3. 재시도와 스냅샷

### RQ-011 변경 요청의 멱등성

- [x] **진행 상태:** 검증 완료

**요구사항:**

- 호출자는 생성·교체·스냅샷 생성·복원·삭제 요청에 멱등성 키를 지정할 수 있어야 한다.
- 동일 요청 판별은 유효한 namespace·호출자 범위에서 fingerprint를 완성할 수 있는 요청에 적용한다.
- namespace·호출자 범위·키·요청 내용으로 동일 요청을 판별해야 한다.
- 동일 요청의 재전송에는 최초 확정 결과를 재생해야 한다.
- 같은 키를 다른 요청에 사용하면 재사용 오류를 반환해야 한다.
- fingerprint 완성 전에 거부한 요청은 receipt를 남기지 않는다.
- 해당 요청은 재시도 시 다시 평가한다.
- 파일 크기 상한을 넘긴 콘텐츠 스트림은 본문 전체를 소비해 hash하지 않는다.
- 해당 요청은 최초 응답 bytes·request ID의 재생을 보장하지 않는다.

**수용 조건:**

- fingerprint를 완성할 수 있는 요청은 응답 유실 직후와 Storix 재시작 후 재시도해도 변경을 한 번만 적용하고 최초 확정 결과를 재생한다.
- fingerprint 이전에 끝난 오류는 receipt 없이 재평가되며, 그 최초 응답 bytes의 동일성은 보장하지 않는다.

**판정 근거:**

- PostgreSQL 통합 검증에서 조건부 변경·raw upload의 receipt 재생과 앱 재시작 후 결과 재생, 같은 키의 다른 fingerprint에 대한 `MUTATION_KEY_REUSED`를 확인했다.
- 파일 크기 상한을 넘긴 스트리밍 요청은 413 receipt를 만들지 않고, 같은 키의 다음 요청을 다시 평가하는 것도 확인했다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `mutation-replay`:
    - 같은 키·같은 요청은 그 사이 파일이 바뀌어도 최초 status·본문·`X-Request-Id`를 재생하고 다시 적용하지 않음.
    - 같은 키의 다른 요청은 409 `MUTATION_KEY_REUSED`.
    - 조건부 저장과 delete 대상.
  - `mutation-replay-restart`: 재시작 뒤 성공·412·delete 응답을 최초 결과로 재생.
  - `mutation-header-validation`:
    - 헤더 누락·형식 오류는 400 `VFS_INVALID_MUTATION_REQUEST`.
    - 거부한 요청의 receipt 미생성.
    - 헤더를 고친 재요청은 정상 처리.
  - `mutation-header-validation-lifecycle`:
    - snapshot 복원·삭제의 같은 400과 무변경.
    - 휴지통 복구·purge의 같은 400과 무변경.
    - 헤더를 고친 재요청은 정상 처리.
- `mutation-header-validation-upload-session`이 업로드 세션 생성의 헤더 오류를 확인했다.
  - `resumable-upload` 프로필: 업로드 세션 생성의 같은 헤더 오류가 400이고 receipt를 남기지 않아 같은 key를 scope만 고쳐 다시 보내면 201.
- `upload-session-complete`는 세션 생성·완료의 같은 요청이 최초 201 본문과 `X-Request-Id`를 재생하고(생성은 완료 뒤에도) 다른 요청의 같은 key는 409 `MUTATION_KEY_REUSED`임을 확인했다.
- `snapshot-mutation-replay` 계약이 통과했다.
  - 대상은 snapshot 생성·복원·삭제.
  - 같은 키·같은 요청은 최초 status·본문·`X-Request-Id` 재생.
  - 원본·복원 대상 변경 또는 snapshot 삭제 후에도 같은 결과 재생.
  - 요청 재적용 없음.
  - 같은 키의 다른 요청은 409 `MUTATION_KEY_REUSED`이고 대상은 그대로.
- `file-size-no-receipt`도 통과했다.
  - `small-limits` 프로필: 상한 초과는 413 `VFS_FILE_TOO_LARGE`.
  - 상한 초과 요청의 receipt 미생성.
  - 같은 키·같은 요청은 재평가 후 413.
  - 본문이 다른 상한 안 요청은 409가 아니라 201.
  - 처리 뒤 재전송은 최초 응답을 재생.
- SQLite·PostgreSQL 계약 검증에서 `namespace-idempotency-key-length`가 통과했다.
  - namespace 생성은 255 byte `Idempotency-Key`로 201이고 같은 키·같은 요청은 재생한다.
  - 256 byte 키는 400 `IDEMPOTENCY_KEY_REQUIRED`이고 namespace를 만들지 않는다.
  - 수정 전 구현에서는 PostgreSQL이 500, SQLite는 계약이 실패했다.
- 계약은 진행 중 key(`MUTATION_IN_PROGRESS`)를 포함하지 않는다.

### RQ-012 스냅샷 생성

- [x] **진행 상태:** 로컬 코드·통합 검증 완료

**요구사항:**

- 호출자는 지정 파일의 현재 revision을 조건으로 불변 스냅샷을 만들 수 있어야 한다.
- 생성 결과에는 스냅샷 ID, 원본 파일 ID·경로·revision, 생성 시각, 크기, 해시가 포함되어야 한다.
- 조건이 맞지 않으면 스냅샷을 남기지 않아야 한다.

**수용 조건:**

- 파일 변경과 스냅샷 생성이 경합할 때 스냅샷은 명시한 revision의 바이트만 보존하거나 충돌로 거부된다.

**판정 근거:**

- 조건부 FILE snapshot 생성 결과에 snapshot ID·`rootNodeId`(원본 파일 ID)·원본 경로·revision·생성 시각·크기·보존 바이트 `sha256`이 포함된다.
- PostgreSQL `fs.integration-spec.ts` L1 141/141에서 원본 교체와 캡처 경합의 revision·해시·바이트 일치 및 조건 실패 시 무생성을 확인했다.
- SQLite ENCRYPTED snapshot L1은 최초 8/10 통과 후 기존 412 기대값 두 곳을 수정해 해당 사례 2/2 통과했다.
- 최종 PostgreSQL L2의 파일 HTTP suite에서 snapshot 삭제 경합 사례가 통과했고 SQLite L2 12 suites/213 tests에서 원본 이동 사례가 통과했다.
- PostgreSQL L2 전체의 기존 412 repository 기대값 실패는 수정 후 해당 spec 114/114 통과했다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `snapshot-create`:
    - 원본 파일 ID·경로·revision·크기·해시·생성 시각 반환.
    - `sourceRevision` 불일치 412와 snapshot 미생성.
  - `snapshot-create-race`:
    - 교체 중 요청한 snapshot은 지정 revision의 바이트만 보존.
    - 커밋 이후 요청은 412.
- 계약은 TREE snapshot을 포함하지 않는다.

### RQ-013 파일별 스냅샷 목록

- [x] **진행 상태:** 로컬 코드·통합 검증 완료

**요구사항:**

- 호출자는 파일 ID를 기준으로 해당 파일의 스냅샷을 페이지 단위로 나열할 수 있어야 한다.
- 각 항목은 스냅샷 ID, 생성 시각, 원본 revision, 크기, 해시를 포함해야 한다.
- 파일의 경로 변경은 해당 목록의 소속을 바꾸지 않으며, 삭제 후 같은 경로에 새로 만든 파일의 목록과 섞이지 않아야 한다.

**수용 조건:**

- 스냅샷 여러 건을 누락·중복 없이 조회하고, 파일 이동·동일 경로 재생성 후에도 소속이 유지된다.

**판정 근거:**

- API v2에 namespace와 immutable `rootNodeId`로 FILE snapshot을 keyset 조회하는 endpoint와 DB 복합 인덱스를 추가했다.
- PostgreSQL repository L1 20/20, SQLite repository L1 41/41, SQLite HTTP L1 11/11 통과.
- PostgreSQL HTTP L1 첫 실행은 stale 오류 기대 2건과 lease-renewal timing assertion 1건으로 141/143, stale 기대를 갱신한 재실행은 142/143이었다.
- 승인된 단일 timing 실패 재실행 1/1 통과 후 L2 PostgreSQL 전체 27 suites/416 tests와 SQLite 전체 12 suites/217 tests가 통과했다.
- L2에는 PostgreSQL/SQLite repository, HTTP, migration 검증이 포함된다.
- 실 Jupyter/WAS 연동은 검증하지 않았다.
- SQLite 계약 검증에서 `snapshot-list`가 통과했다.
  - snapshot 5건을 limit 2로 순회해 누락·중복 없이 조회.
  - 이동과 삭제 후 같은 경로 재생성 뒤에도 소속 유지.
- 계약은 목록 정렬 순서를 검증하지 않는다.
- SQLite·PostgreSQL 계약 검증에서 `snapshot-list-cursor-validation`이 통과했다.
  - 존재하지 않는 날짜(`2026-02-30`)와 `0000`년을 담은 cursor는 400 `VFS_INVALID_CURSOR`.
  - 거부된 뒤 서버가 만든 cursor로 다음 페이지를 읽는다.
  - 수정 전 구현에서는 PostgreSQL이 500이었다.

### RQ-014 스냅샷 바이트 조회

- [x] **진행 상태:** 로컬 코드·통합 검증 완료

**요구사항:**

- 호출자는 스냅샷 ID로 생성 당시의 전체 파일 바이트와 메타데이터를 읽을 수 있어야 한다.
- 원본 파일의 수정·이동·삭제는 보존 중인 스냅샷 내용을 바꾸지 않아야 한다.

**수용 조건:**

- 원본 변경 또는 삭제 뒤에도 스냅샷 바이트·크기·해시가 생성 직후와 같다.

**판정 근거:**

- FILE snapshot 생성·ID 조회는 보존 root entry의 Blob SHA-256을 반환하고 전체 바이트 조회는 같은 보존 Blob을 읽는다.
- SQLite ENCRYPTED snapshot L1에서 생성·receipt 재생·재시작·원본 교체·삭제 뒤 메타데이터와 바이트 일치를 확인했다(최초 8/10, 기존 412 기대값 수정 후 실패 사례 2/2).
- 최종 SQLite L2 12 suites/213 tests에서 원본 이동 직후의 불변성을 확인했고, PostgreSQL L2의 파일 HTTP suite에서 snapshot 삭제 경합 사례가 통과했다.
- PostgreSQL L2 전체의 기존 412 repository 기대값 실패는 수정 후 해당 spec 114/114 통과했다.
- TREE의 `sha256`은 `null`이다.
- SQLite 계약 검증에서 `snapshot-immutable`이 통과했다.
  - 원본 수정·이동·삭제 뒤에도 snapshot 바이트·크기·해시가 생성 직후와 같음.
- 계약은 암호화 namespace와 Range 조회를 포함하지 않는다.

### RQ-015 조건부 스냅샷 복원

- [x] **진행 상태:** 검증 완료

**요구사항:**

- 호출자는 스냅샷 바이트를 지정 경로의 현재 파일로 복원할 수 있어야 한다.
- 대상 파일이 있으면 현재 revision 일치 조건이, 없으면 부재 조건이 필요하다.
- 성공 시 대상 파일에 새 revision을 발급하고 스냅샷 자체는 보존해야 한다.

**수용 조건:**

- 오래된 대상 revision으로 복원하면 변경 없이 충돌하며, 정상 복원 후 대상 바이트는 스냅샷과 같고 revision은 복원 전과 다르다.

**판정 근거:**

- 부재·revision 조건별 복원, 충돌 시 무변경, 새 revision과 스냅샷 보존을 PostgreSQL 통합 사례로 확인했다.
- SQLite 계약 검증에서 `snapshot-restore`가 통과했다.
  - 오래된 대상 revision·부재 조건 불일치 412와 무변경.
  - 조건 누락 428.
  - 정상 복원 후 바이트가 snapshot과 같고 revision이 달라짐.
  - 부재 경로 201 복원.
  - snapshot 보존.

### RQ-016 스냅샷 삭제와 보존

- [x] **진행 상태:** 검증 완료

**요구사항:**

- 호출자는 특정 스냅샷을 명시적으로 삭제할 수 있어야 한다.
- 삭제는 현재 파일과 다른 스냅샷을 변경해서는 안 된다.
- 자동 만료·개수 제한을 도입한다면 보존 정책과 삭제 시점을 공개 계약으로 먼저 정의해야 하며, 정의되지 않은 자동 삭제는 허용하지 않는다.

**수용 조건:**

- 하나의 스냅샷 삭제 뒤 현재 파일과 나머지 스냅샷을 동일하게 조회할 수 있다.

**판정 근거:**

- 명시적 삭제와 다른 스냅샷·현재 파일의 보존을 통합 사례와 삭제 트랜잭션에서 확인했다.
- SQLite 계약 검증에서 `snapshot-delete`가 통과했다.
  - 한 snapshot 삭제 뒤 삭제한 snapshot은 404.
  - 현재 파일·나머지 snapshot의 메타데이터·바이트·목록이 그대로.
- 계약은 자동 만료·개수 제한을 다루지 않는다(도입하지 않았다).

## 4. 오류·한도·운영 계약

### RQ-017 크기 및 저장량 한도

- [x] **진행 상태:** 완료

**요구사항:**

- Storix는 파일 한 건의 최대 바이트 수와 namespace의 현재 파일·보존 스냅샷 사용량 상한을 적용할 수 있어야 한다.
- 호출자는 적용 한도와 사용량을 확인할 수 있어야 한다.
- 초과 요청은 기존 파일·스냅샷·revision을 변경하지 않고 한도 유형을 식별할 수 있는 오류를 반환해야 한다.

**수용 조건:**

- 업로드와 스냅샷 생성·복원 각각의 한도 초과에서 부분 변경이 없고 오류 유형이 구분된다.

**판정 근거:**

- 인증된 `GET /api/v2/namespaces/{id}`가 적용 단일 파일 상한 `limits.maxFileSizeBytes`와 논리 quota의 `limitBytes`·`usedBytes`를 바이트 단위 10진 문자열로 반환한다.
- 파일 상한은 namespace 재정의와 `STORIX_MAX_FILE_SIZE_BYTES` 중 작은 값이다.
- 전역 기본값은 `5368709120`이다.
- DTO/OpenAPI L0 2 suites/13 tests, namespace HTTP L1 20/20에서 값·quota 사용량·인증 거부를 확인했다.
- PostgreSQL 전체 L2 27 suites/419 tests와 SQLite 전체 L2 12 suites/217 tests가 통과했다.
- 파일 HTTP L2에서 한도 초과 오류를 확인했다.
  - 업로드: 413 `VFS_FILE_TOO_LARGE`.
  - snapshot 생성: 413 `VFS_SNAPSHOT_LIMIT_EXCEEDED`.
  - 복원 quota: 413 `VFS_QUOTA_EXCEEDED`.
- 각 사례에 맞춰 대상 파일·snapshot·Blob 참조·root revision·논리 사용량의 무변경을 단언했다.
- PostgreSQL repository L1은 노드 quota 114/114, snapshot 상한 20/20이 통과했다.
- `pnpm typecheck`와 `pnpm lint`도 최종 테스트 변경 후 exit 0이다.
- 실제 배포 설정, WAS/Jupyter 연동은 검증하지 않았다.
- SQLite 계약 검증(`small-limits` 프로필: 파일 상한 1200, snapshot 상한 800, 논리 상한 2000 바이트)에서 다음 계약이 통과했다:
  - `limits-visible`: namespace 조회가 상한·사용량을 노출하고 저장·snapshot 생성이 사용량에 반영.
  - `file-size-rejection`:
    - 413 `VFS_FILE_TOO_LARGE`.
    - 새 경로·교체 모두 무변경.
    - 상한과 같은 크기는 허용.
  - `quota-rejection`:
    - 413 `VFS_QUOTA_EXCEEDED`.
    - 기존 파일·사용량 무변경.
  - `namespace-quota-override`:
    - 관리자 PATCH로 namespace 상한을 전역 이하로 줄이면 그 namespace에만 적용돼 초과 저장이 413.
    - 전역보다 1 큰 값은 400 `NAMESPACE_QUOTA_LIMIT_EXCEEDS_GLOBAL`.
    - null은 전역 상한 상속.
  - `namespace-quota-admin-errors`:
    - 서비스 key·틀린 key 401.
    - 형식 오류 400 `NAMESPACE_INVALID_TOTAL_LOGICAL_BYTES`.
    - key 누락 400 `IDEMPOTENCY_KEY_REQUIRED`.
    - 없는 namespace 404.
    - 같은 key 같은 요청 재생과 다른 요청 422 `IDEMPOTENCY_KEY_REUSED`.
  - `namespace-quota-request-shape`:
    - 추가 필드가 있는 quota 변경은 400 `NAMESPACE_INVALID_TOTAL_LOGICAL_BYTES`이고 상한 유지.
    - 사용량보다 낮은 상한은 200이며 저장된 파일은 그대로 읽히고 새 저장만 413 `VFS_QUOTA_EXCEEDED`.
  - `snapshot-limit-rejection`:
    - 413 `VFS_SNAPSHOT_LIMIT_EXCEEDED`.
    - snapshot 미생성.
  - `snapshot-restore-quota-rejection`:
    - 복원 413 `VFS_QUOTA_EXCEEDED`.
    - 대상 경로·snapshot·사용량 무변경.
  - `snapshot-create-quota-rejection`:
    - 사용량이 상한을 넘는 snapshot 생성 413 `VFS_QUOTA_EXCEEDED`.
    - 기존 snapshot·파일·사용량 무변경.
  - `trash-restore-quota-rejection`:
    - 휴지통을 quota에서 제외한 namespace에서 상한을 넘는 복구 413 `VFS_QUOTA_EXCEEDED`.
    - 휴지통 항목·경로·검사 대상 사용량 무변경.
  - `folder-file-limit-rejection`:
    - 폴더 파일 수 상한 초과 touch·저장·mv·cp·mutations move·휴지통 복구 413 `VFS_FOLDER_FILE_LIMIT_EXCEEDED`.
    - 대상 경로 미생성, 디렉터리 생성과 기존 파일 교체는 허용.
  - `namespace-node-limit-rejection`:
    - live 노드 수 상한 초과 저장·mkdir·touch·cp·mutations mkdir 413 `VFS_NAMESPACE_NODE_LIMIT_EXCEEDED`.
    - 대상 경로 미생성, 기존 파일 교체는 허용.
  - 위 4개 계약은 SQLite와 Postgres에서 통과했다.
- 계약은 TREE snapshot·삭제·복사 노드 상한, 휴지통 사용량, 보존 snapshot 상한을 다루지 않는다.

### RQ-018 안정적인 오류 분류

- [x] **진행 상태:** 완료

**요구사항:**

- Storix는 최소한 호출 인증 실패, namespace 없음, 경로 오류, 파일 없음, 파일 유형 오류, revision 충돌, 멱등성 키 재사용, 스냅샷 없음, 크기·저장량 초과, 저장 장애를 기계적으로 구분할 수 있는 오류 코드를 제공해야 한다.
- 재시도 가능한 일시적 오류와 확정된 거부도 구분해야 한다.

**수용 조건:**

- 호출 서버가 오류 메시지 문자열을 파싱하지 않고 코드만으로 각 경우를 처리할 수 있다.

**판정 근거:**

- 오류 계약은 `apps/api/openapi.yaml`에 공개했다.
- 인증/namespace·node·snapshot 부재는 401/404 코드, 입력·유형·revision·key·상한 거부는 기존 4xx 코드, `DB_BUSY`는 503, 식별된 transient DB/Blob 장애는 503 `STORAGE_UNAVAILABLE`, 식별된 permanent 저장 장애는 500 `STORAGE_FAILURE`, 미분류 예외는 500 `INTERNAL_ERROR`다.
- 분류할 수 없는 500은 안전한 고정 메시지를 반환한다.
- 내부 예외·저장소 정보·파일 바이트·비밀을 노출하지 않는다.
- 같은 key로 자동 재시도 가능한 코드는 `DB_BUSY`·`STORAGE_UNAVAILABLE`·`MUTATION_IN_PROGRESS`다.
- `Retry-After`가 있으면 먼저 기다린다.
- 결정적 4xx 오류 receipt는 최초 응답을 재생한다.
- 상태·입력을 고친 요청은 새 key를 사용한다.
- `STORAGE_FAILURE`·`INTERNAL_ERROR`는 자동 재시도를 약속하지 않는다.
- 해당 오류는 원인 조사를 요구한다.
- SQLite 계약 검증에서 `error-codes`와 한도 계약 5개(413 세 코드 구분), `mutation-header-validation`이 통과했다.
  - `error-codes`:
    - 인증 실패 401 `UNAUTHORIZED`.
    - namespace 없음 404 `NAMESPACE_NOT_FOUND`.
    - 경로 오류 400 `VFS_INVALID_PATH`.
    - 파일 없음 404 `VFS_NODE_NOT_FOUND`.
    - 유형 오류 409 `VFS_IS_DIRECTORY`·`VFS_NOT_DIRECTORY`.
    - revision 형식 오류 400 `VFS_INVALID_REVISION`.
    - revision 충돌 412 `VFS_PRECONDITION_FAILED`.
    - 조건 누락 428 `VFS_PRECONDITION_REQUIRED`.
    - namespace 생성의 key 누락 400 `IDEMPOTENCY_KEY_REQUIRED`.
    - key 재사용 409 `MUTATION_KEY_REUSED`.
    - snapshot 없음 404 `VFS_SNAPSHOT_NOT_FOUND`.
    - 각 오류는 상태와 `code`로 구분.
    - 각 오류에 `requestId` 포함.
    - code 중복 없음.
  - `mutation-header-validation`:
    - 조건부 저장·조건부 mutation·snapshot 생성에서 `Idempotency-Key`·`X-Mutation-Scope`의 누락·비UUID key·빈 값·129바이트 scope가 400 `VFS_INVALID_MUTATION_REQUEST`이고 상태 무변경.
    - 128바이트 scope는 통과.
- `storage-unavailable-retry`와 `storage-object-lost`가 통과했다.
  - `storage-unavailable-retry`:
    - 러너가 blob 저장소를 멈추면 저장·조회는 503 `STORAGE_UNAVAILABLE`.
    - 내부 정보 미노출.
    - 거부된 저장은 경로를 만들지 않고 저장소 복구 뒤 같은 `Idempotency-Key` 재시도가 201.
    - 기존 파일 바이트 유지.
  - `storage-object-lost`: 저장소가 객체를 잃으면 조회가 500 `STORAGE_FAILURE`이고 재시도해도 같으며 다른 경로의 새 저장은 성공.
- `upload-session-lifecycle`은 업로드 세션의 404 `VFS_UPLOAD_SESSION_NOT_FOUND`와 409 `VFS_UPLOAD_SESSION_CLOSED`를, `mutation-header-validation-upload-session`은 업로드 세션 생성의 헤더 오류 400 `VFS_INVALID_MUTATION_REQUEST`를 확인했다.
  - `resumable-upload` 프로필.
- 계약은 `DB_BUSY`·`INTERNAL_ERROR` 발생, DB 장애, `Retry-After`를 다루지 않는다(`Retry-After`는 있을 때만 준수하는 값이고 이 저장소 장애 응답에는 없었다).
- 저장소를 멈춘 동안에도 `stat`·`mkdir`·snapshot 생성은 성공했으나 계약은 이를 단언하지 않는다.
- SQLite·PostgreSQL 계약 검증에서 `find-input-validation`이 통과했다.
  - `find`의 cursor 오류(UUID가 아닌 `id`, NUL이 든 `name`, 중복 `cursor`)는 400 `VFS_INVALID_CURSOR`.
  - `find`의 `name`이 중복되거나 NUL을 포함하면 `match` 값(생략 포함)과 관계없이 400 `VFS_INVALID_QUERY`.
  - 거부된 뒤 `name`·`match` 검색은 그대로 동작하고 빈 `name`은 필터 없음이다.
  - 수정 전 구현에서는 PostgreSQL이 500이었다.
- SQLite·PostgreSQL 계약 검증에서 길이 상한 계약 3개가 통과했다.
  - `upload-session-request-id-length`(`resumable-upload` 프로필): 200자 `X-Request-Id`로 업로드 세션 생성·완료가 201이고 같은 ID를 돌려준다. 201자는 서버가 만든 ID로 대체된다.
  - `content-type-length`: 파라미터를 뗀 `Content-Type`이 255자면 그대로, 256자면 `application/octet-stream`으로 저장한다. 조건부·무조건 저장 모두 201이다.
  - `namespace-idempotency-key-length`: RQ-011 판정 근거에 적었다.
  - 수정 전 구현에서는 PostgreSQL이 세 계약 모두 500 또는 계약 실패였고, SQLite는 `content-type-length`와 `namespace-idempotency-key-length`가 실패했다.

**자동 검증 근거:**

- 단위 `pnpm test`는 API 79 suites/752 tests 통과, `route-coverage.spec.ts` 포함.
- 표적 PostgreSQL L1: `fs.integration-spec.ts` 146/146, `content-streaming.integration-spec.ts` 4/4, `namespace.integration-spec.ts` 21/21.
- SQLite L1 `vfs-snapshot.sqlite.integration-spec.ts` 12/12.
- 최종 L2 `pnpm test:integration --filter='!@cp949/storix-demo1-was'` 27 suites/424 tests, `pnpm --filter @cp949/storix-api test:integration:sqlite` 12 suites/218 tests 통과.
- root L0 typecheck/lint/test/build도 통과했다.
- 전 연산별 장애 주입 확장은 수행하지 않았다.
- HTTP/receipt/stream 경계를 검증했다.

**검증 경계:**

- 오류 주입은 repository·S3 SDK seam 및 실제 SQLite gate를 사용한 자동 테스트다.
- 소비자 어댑터의 자동 재시도 동작, 실행 중인 외부 DB/스토리지의 실장애와 복구, production 배포는 검증하지 않았다.
- 응답 중단은 raw HTTP client 수준에서만 확인했다.

### RQ-019 감사에 필요한 호출 정보

- [x] **진행 상태:** 로컬 코드·자동 검증 완료

**요구사항:**

- Storix는 읽기·변경 요청에 대해 요청 ID, 호출 서버 식별, namespace, 대상 파일 또는 스냅샷, 작업 유형, 결과를 추적할 수 있어야 한다.
- 호출자가 제공한 최종 사용자 식별값은 자기신고 값으로 취급하고 Storix의 권한 판단 근거로 사용하지 않아야 한다.

**수용 조건:**

- 호출 서버의 요청 ID로 Storix의 성공·거부 기록을 연결할 수 있고, 파일 본문과 인증 비밀은 기록에 포함되지 않는다.

**판정 근거:**

- 성공 요청은 기존 `AuditLogInterceptor`가 request ID, caller, namespace, operation, 대상 경로, HTTP 결과를 기록한다.
- `InvalidApiKeyError`는 공통 예외 필터에서 `request_id`, HTTP method와 request path로 구성한 128자 operation, 전체 request path, 401 결과를 best-effort 기록하며 caller·namespace는 null로 둔다.
- 감사 행은 nullable `snapshot_id`를 가지며 생성 결과와 개별 ID 경로를 기록하고 목록은 null을 유지한다.
- snapshot 감사 ID는 PostgreSQL/SQLite migration과 저장 테스트로 확인했다.
- 단위·PostgreSQL 통합 검증은 키 원문과 본문 미기록 및 저장 실패 시 401 응답 보존을 확인한다.

**자동 검증 근거:**

- `pnpm test` 79 suites/768 tests, PostgreSQL L2 27 suites/437 tests, SQLite L2 13 suites/228 tests 통과.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` 통과.
- PostgreSQL 감사 E2E 6 tests는 HTTP 인증 거부와 snapshot ID별 생성·조회·entries·content·restore·delete 및 목록 미기록을 확인했다.

**검증 경계:**

- 로컬 자동 테스트의 disposable PostgreSQL/SQLite만 확인했다.
- 운영 DB migration 적용, 운영 로그 조회·보존, 외부 호출 서버의 요청 ID 연결은 검증하지 않았다.
- 공개 경로 및 API key 거부 이외의 새 4xx 감사 경로는 포함하지 않는다.

### RQ-020 호출 계약 공개

- [x] **진행 상태:** 공개 계약·정적 대조 완료

**요구사항:**

- Storix는 요청 조건, 성공 응답 필드, revision·해시의 의미, 오류 코드, 경로 규칙, 멱등성 키의 범위·보존 기간, 크기·저장량 한도를 호출 서버가 확인할 수 있도록 문서화해야 한다.
- 배포 시 설정에 따라 달라지는 값은 실행 중 확인 방법을 제공해야 한다.

**수용 조건:**

- 소비자 어댑터 구현자가 Storix 내부 코드나 DB를 읽지 않고도 생성→조회→조건부 교체→스냅샷→복원 흐름을 구현할 수 있다.

**판정 근거:**

- `apps/api/openapi.yaml`에 namespace 조회를 통한 실행 중 단일 파일 상한·논리 사용량 확인, 인증된 파일 생성·조회·조건부 교체·FILE snapshot 생성/조회/콘텐츠/복원 curl 흐름을 추가했다.
- 응답의 파일 ID·불투명 revision·전체 바이트 SHA-256 의미, 조건부 오류, namespace/scope/key receipt identity와 완료 후 30일 재생 및 만료 후 재평가 가능성을 함께 설명한다.
- 적용 경로·요청 필드·응답 필드는 현재 라우트·DTO 및 기존 통합 테스트와 정적으로 대조했다.

**검증 경계:**

- 로컬 문서·코드 계약 대조만 수행한다.
- 예시를 배포된 서버나 외부 WAS에서 실행하지 않았고, namespace 운영 설정·실제 저장소·운영 receipt 보존/GC를 검증하지 않았다.
- TREE snapshot은 전체 OpenAPI 계약에 남아 있으나 이 요구사항의 필수 노트북 예시에는 포함하지 않는다.

### RQ-021 Range 부분 콘텐츠 조회

- [x] **진행 상태:** 구현 및 계약 검증 완료

**요구사항:**

- 호출자는 전체 파일을 받지 않고 byte range로 콘텐츠 일부를 조회할 수 있어야 한다.
- 부분 응답은 해당 바이트가 속한 안정 파일 ID와 revision을 식별할 수 있어야 한다.
- 전체 파일 SHA-256은 부분 응답의 검증값으로 사용하지 않는다.

**수용 조건:**

- 단일 byte range의 시작-끝, 열린 끝, suffix 요청은 지정 구간의 바이트와 길이, `Content-Range`를 일치시켜 반환한다.
- 범위를 처리할 수 없는 요청은 `416`으로 거부한다.
- 파일 `206`에는 파일 ID와 revision이 포함되며, 전체 SHA-256 헤더의 의미를 부분 바이트 해시로 바꾸지 않는다.

**판정 근거:**

- 단일 Range의 시작-끝·열린 끝·suffix와 clipping 및 긴 suffix 처리, 잘못된 문법·복수·충족 불가 범위의 416은 단위 2 suites/45 tests, PostgreSQL L1 2 suites/167 tests에서 확인했다.
- 인증·PUBLIC content/download의 206 bytes·길이·`Content-Range`·파일 ID/revision 및 파일 교체 경합, 암호화 파일과 FILE/TREE snapshot의 206 식별자는 단위 4 suites/90 tests와 PostgreSQL L1 3 suites/174 tests에서 확인했다.
- 인증 PRIVATE 파일의 빈 파일 및 `start == size` 416 응답은 PostgreSQL `public-fs.integration-spec.ts`에서 `Content-Range`와 기존 오류 envelope를 확인했다.
- 다섯 GET operation의 OpenAPI 206/416 헤더, 기존 416 JSON error schema/code, 공통 Range 설명은 `route-coverage.spec.ts` 12/12와 `error-contract.spec.ts` 5/5로 확인했다.
- 최종 `pnpm test`는 API 88 suites/872 tests, demo1-was 15/73, demo1-web 7/39 통과했고 typecheck·lint·build가 모두 통과했다(lint는 기존 demo1-web 경고 4건, 오류 0건).
- PostgreSQL L2는 33 suites/495 tests, SQLite L2는 19 suites/287 tests 통과했다.
- 206은 전체 파일 `X-Storix-Sha256`을 제공하지 않는다.
- 배포·외부 소비자·운영 proxy/storage 검증은 수행하지 않았다.
- SQLite 계약 검증에서 `range-content`가 통과했다.
  - 시작-끝·열린 끝·suffix·끝을 넘는 범위의 206이 지정 바이트·`Content-Length`·`Content-Range`·파일 ID·revision과 일치.
  - 잘못된 문법·복수 범위·충족 불가 범위는 416.
- `public-namespace-read`도 통과했다.
  - PUBLIC namespace의 공개 content·download 두 경로가 무인증으로 시작-끝·열린 끝·suffix에 206 지정 구간·`Content-Range`와 인증 경로가 알리는 파일 ID·revision을.
  - 충족 불가 범위에 416 `VFS_RANGE_NOT_SATISFIABLE`과 `bytes */<길이>`를 돌려줌.
- 계약은 snapshot content·인증 `/fs/download`·암호화 파일의 Range를 다루지 않는다.

**관련 계약:**

- `GET /api/v2/namespaces/{namespaceId}/fs/content`, `/fs/download`, 공개 콘텐츠·다운로드 경로, snapshot 콘텐츠 경로의 `Range` / `206` / `416` 응답.

### RQ-022 디렉터리 자식 목록과 cursor 일관성

- [ ] **진행 상태:** 진행 중

**요구사항:**

- 호출자는 디렉터리의 직계 자식을 cursor 페이지로 열거할 수 있어야 한다.
- `consistency=revision`을 선택한 열거는 한 디렉터리 revision에 일관되어야 한다.

**수용 조건:**

- cursor가 묶인 디렉터리 revision이 더 이상 현재 revision과 다르면 다음 페이지는 `412 VFS_PRECONDITION_FAILED`로 거부한다.
- 형식이 잘못되거나 변조된 cursor는 `400 VFS_INVALID_CURSOR`다.
- 호출자는 첫 페이지부터 다시 열거하며, 서로 다른 디렉터리 상태의 페이지를 조용히 이어 붙이지 않는다.

**판정 근거:**

- OpenAPI는 `GET /api/v2/namespaces/{namespaceId}/fs/ls`의 cursor pagination·`consistency=revision`을 공개한다.
- cursor의 디렉터리 revision이 현재와 다르면 412 `VFS_PRECONDITION_FAILED`로 응답한다.
- 이 계약은 구현과 일치한다.
- SQLite 계약 검증에서 `ls-pagination`이 통과했다.
  - cursor 페이지가 누락·중복 없이 열거되고.
  - revision 열거의 모든 페이지가 현재 `directoryRevision`을 반환.
  - 디렉터리 변경 후 이전 cursor의 다음 페이지는 412 `VFS_PRECONDITION_FAILED`.
  - 서로 다른 상태의 페이지 연결 없음.
  - 형식이 잘못된 cursor는 400 `VFS_INVALID_CURSOR`.
- SQLite·PostgreSQL 계약 검증에서 `ls-cursor-validation`이 통과했다.
  - UUID가 아닌 `id`, 빈 `id`, NUL이 든 `name`을 담은 cursor는 400 `VFS_INVALID_CURSOR`.
  - 같은 `cursor`를 여러 번 보낸 요청도 400 `VFS_INVALID_CURSOR`.
  - 거부된 뒤 서버가 만든 cursor로 다음 페이지를 읽는다.
  - 수정 전 구현에서는 PostgreSQL이 500, SQLite는 계약이 실패했다.

**관련 계약:**

- `GET /api/v2/namespaces/{namespaceId}/fs/ls`, `cursor`, `consistency=revision`, `rc1.` cursor 및 `directoryRevision`.

### RQ-023 디렉터리 생성

- [ ] **진행 상태:** 진행 중

**요구사항:**

- 호출자는 기존 디렉터리를 중복 생성하지 않고 필요한 경로에 디렉터리를 만들 수 있어야 한다.
- 없는 부모를 자동 생성할지는 요청에서 명시해야 한다.

**수용 조건:**

- `parents=true`로 한 기존 디렉터리 생성 재요청은 기존 디렉터리 ID와 상태를 보존하는 멱등 성공이다.
- `parents`를 생략하거나 false로 한 재요청은 상태를 바꾸지 않고 `409 VFS_ALREADY_EXISTS`로 거부한다.
- `parents` 또는 `destinationParents`를 생략하거나 false로 두면 부모 디렉터리를 암묵적으로 만들지 않는다.
- true인 경우 부모 생성과 대상 생성은 모두 적용되거나 모두 적용되지 않는다.

**판정 근거:**

- OpenAPI의 `/fs/mkdir` 재요청 계약은 구현과 일치한다.
  - `parents=true`: 기존 디렉터리에 200 멱등 성공.
  - `parents` 생략·false: 기존 디렉터리에 409 `VFS_ALREADY_EXISTS`.
- 조건부 `/fs/mutations`의 mkdir은 부재 조건을 사용한다.
- 부모 자동 생성은 공통 경로 계약상 명시적 옵션에 달려 있다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `mkdir-parents`:
    - `parents` 생략·false는 없는 부모에 404이고 부모를 만들지 않음.
    - `parents=true`는 부모와 대상을 함께 만들고 이미 있는 디렉터리의 재요청은 200으로 같은 ID·상태.
    - `parents` 생략·false로 이미 있는 디렉터리를 다시 요청하면 409 `VFS_ALREADY_EXISTS`.
    - 경로 중간이 파일이면 409.
    - 조건부 mkdir은 기존 대상 412·없는 부모 404.
  - `destination-parents`: 이동·복사의 `destinationParents`.

**관련 계약:**

- `POST /api/v2/namespaces/{namespaceId}/fs/mkdir`, `/fs/mutations`의 `kind: mkdir`, 공통 `parents` 규칙.

### RQ-024 파일·디렉터리 삭제

- [x] **진행 상태:** 로컬 구현·공개 계약·자동 검증 완료

**요구사항:**

- 호출자는 파일과 디렉터리를 삭제할 수 있어야 한다.
- 조건부 삭제는 현재 대상 revision을 확인해야 한다.
- 재귀 삭제는 subtree 전체를 한 연산으로 처리해야 한다.
- 삭제된 경로를 다시 생성한 파일은 이전 파일과 다른 ID를 가진다.
- snapshot은 원본 파일 삭제와 독립적으로 보존된다.
- 휴지통 정책은 namespace별이며 기본 OFF다.
- 관리자는 별도 admin key와 `Idempotency-Key`가 있는 PATCH로 변경하고 namespace 응답에서 값을 조회한다.
- 정책 변경과 삭제는 같은 namespace root mutation lock 아래 직렬화된다.
- ON 삭제는 live byte를 trash byte로 옮겨 만료 뒤에도 purge commit까지 quota에 포함한다.
- OFF 삭제는 live byte와 live Blob reference를 감소시킨다.
- 기존 trash item은 OFF 전환 뒤에도 목록·복원·purge 가능하며, 복원은 원래 ID와 새 revision으로 live quota/Blob 참조를 회복한다.
- 휴지통 항목은 원래 ID·revision·상대 경로·Blob metadata를 30일간 보존한다.
- `STORIX_MAX_RETAINED_TRASH_NODES`는 namespace당 기본 100000개이며 양의 안전 정수만 허용한다.
- 직접 purge는 관리자 key와 receipt가 필요하며, GC는 `expiresAt <= DB now` 후보를 제한된 배치로 같은 purge 경로에 전달한다.
- Purge는 다른 live·snapshot·trash Blob 참조를 보존한다.
- 삭제와 복구는 change feed에 각각 `deleted`·`created`를 남기고 목록·purge는 파일 변경 이벤트를 만들지 않는다.
- 조건부 delete receipt는 정책 전환 뒤에도 최초 결과를 재생한다.
- OFF 삭제 응답 및 감사 row에는 trash ID가 없다.

**수용 조건:**

- revision 불일치, 비재귀 삭제 대상 디렉터리의 자식 존재, 삭제 상한 초과, 활성 휴지통의 보존 node 상한 초과는 저장 상태를 바꾸지 않는다.
- ON 재귀 삭제는 subtree 전체를 하나의 복구 가능한 manifest로 이동하거나 아무것도 이동하지 않는다.
- OFF 삭제는 manifest 없이 원자적으로 제거한다.
- 같은 경로의 재생성은 새 파일 ID를 받고, 이미 생성한 snapshot은 명시적으로 삭제하기 전까지 읽을 수 있다.

**판정 근거:**

- namespace별 기본 OFF 정책과 관리자 변경 API를 추가했다.
- ON 삭제는 기존 manifest 계약을 유지하고 OFF 삭제는 manifest 없이 영구 삭제하며 live byte·Blob 참조·change feed를 갱신한다.
- OFF 전환 전 생성된 trash item은 계속 목록·복원할 수 있고 조건부 receipt는 정책 전환 뒤에도 최초 응답을 재생한다.
- PostgreSQL·SQLite focused shared HTTP 테스트는 삭제·복구·receipt, snapshot 독립성, quota·Blob 참조를 확인한다.
- L1 판정 근거의 범위는 race/receipt/audit다.
- OpenAPI도 판정 근거에 포함한다.
- 운영 DB migration, 실제 백업 복원, 외부 consumer/browser/production 연동은 이 판정에 포함하지 않는다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `delete-conditional`:
    - 오래된 revision 412·무변경.
    - 정상 삭제.
    - 재생성 파일의 새 ID.
    - 삭제 뒤 snapshot 보존.
    - 비재귀 삭제의 409 `VFS_DIRECTORY_NOT_EMPTY`.
    - 오래된 디렉터리 revision 412.
    - 재귀 삭제의 하위 전체 제거.
  - `delete-limit-rejection`:
    - 삭제 노드 수 상한 초과 413 `VFS_DELETE_LIMIT_EXCEEDED`.
    - 트리 무변경.
- 휴지통 ON은 `trash-delete-restore`, `trash-purge`, `namespace-trash-policy`, `trash-retention-limit`이 통과했다.
  - `trash-delete-restore`:
    - ON 재귀 삭제의 항목 보존.
    - 복구 충돌 412·부모 없음 404의 무변경.
    - 원래 node ID와 새 revision 복구.
    - `/fs/rm`의 `X-Trash-Id`.
  - `trash-purge`:
    - 관리자 전용 purge.
    - 해당 바이트만 quota 해제.
    - 같은 바이트의 live 파일·snapshot 보존.
    - purge 뒤 복구 404.
  - `namespace-trash-policy`:
    - 기본 OFF.
    - 관리자 전용 PATCH의 오류 분류·재생.
    - OFF 전환 뒤 기존 항목 복구.
  - `trash-retention-limit`: 보존 node 상한 초과 413 `VFS_TRASH_LIMIT_EXCEEDED`의 무변경.
- 계약은 만료·GC purge와 receipt의 정책 전환 뒤 재생을 다루지 않는다.

**관련 계약:**

- `POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 `kind: delete`, `/fs/rm`, `/fs/rmdir`, `/fs/trash` 목록·복구·purge, snapshot content/read/delete 경로 및 [휴지통 설계](../design/09-vfs-trash-and-recovery.md).

### RQ-025 파일·디렉터리 이동

- [ ] **진행 상태:** 진행 중

**요구사항:**

- 이동은 동일 노드와 subtree를 다른 경로에 배치하는 연산이다.
- 이동한 노드와 하위 노드의 ID는 유지하고 경로 및 영향받은 revision은 갱신한다.
- 목적지가 기존 디렉터리면 기본 동작은 그 아래 원본 basename을 배치한다.
- `exact`는 지정 경로 자체가 비어 있어야 한다는 뜻이다.

**수용 조건:**

- 자기 자신 또는 자기 subtree로 디렉터리를 옮길 수 없다.
- revision 불일치, 목적지 충돌, 경로 오류 또는 연산 실패 시 원본과 목적지 트리는 모두 변경되지 않는다.
- 성공하면 subtree 전체가 이동되고 안정 ID는 유지되며 affected revision은 새 상태를 가리킨다.
- 없는 부모는 `destinationParents: true`로 명시할 때만 함께 만든다.

**판정 근거:**

- OpenAPI는 조건부 `/fs/mutations` 및 `/fs/mv`를 공개하고 조건부 경로에는 source revision, destination 부재, 명시적 exact 해석을 표현한다.
- ID·revision 및 실패 시 subtree 보존 요구와 일부 목적지 의미는 추가로 정합화할 필요가 있다.
- runtime 동작은 이 항목에서 재검증하지 않는다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `move-subtree`:
    - 하위 전체 이동.
    - ID·바이트 유지.
    - affected revision이 이동 뒤 revision과 일치.
    - exact 생략 시 기존 디렉터리 아래 배치.
  - `move-rejection`:
    - 자기 subtree 409 `VFS_INVALID_OPERATION`.
    - 오래된 revision·목적지 충돌 412.
    - 없는 원본·부모 404.
    - 잘못된 경로 400.
    - 모두 무변경.
  - `destination-parents`: 이동·복사의 명시적 부모 생성 계약.

**관련 계약:**

- `POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 `kind: move`·`destinationResolution`, `/fs/mv`.

### RQ-026 파일·디렉터리 복사

- [ ] **진행 상태:** 진행 중

**요구사항:**

- 복사는 현재 파일·디렉터리 subtree를 새 자원으로 만든다.
- 복사본은 새 ID와 revision을 가지며 원본의 현재 구조와 파일 바이트를 보존한다.
- 원본 snapshot 이력은 복제하지 않는다.

**수용 조건:**

- 목적지 충돌, 상한 초과, 경로 오류 또는 연산 실패 시 부분 subtree가 남지 않는다.
- 성공한 복사본의 경로·구조·바이트는 연산 시점 원본과 같고 Node ID는 새 값이다.
- 이후 원본과 복사본 각각의 콘텐츠 변경은 다른 쪽에 영향을 주지 않는다.
- 없는 부모는 `destinationParents: true`로 명시할 때만 함께 만든다.

**판정 근거:**

- OpenAPI는 조건부 `/fs/mutations` 및 `/fs/cp`, destination 부재 조건, copy Node 수 상한을 공개한다.
- 새 정체성, 독립 변경 및 snapshot 이력 비복제는 요구사항으로 명시되지만 이 항목에서 구현 검증을 주장하지 않는다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `copy-subtree`:
    - 새 ID로 구조·바이트 복제.
    - 원본 무변경.
    - 원본·복사본 독립 변경.
    - 원본 snapshot 이력 비복제.
  - `copy-rejection`:
    - 자기 subtree 409.
    - 오래된 revision·목적지 충돌 412.
    - 없는 원본·부모 404.
    - 잘못된 경로 400.
    - 부분 트리 없음.
  - `copy-limit-rejection`:
    - 노드 수 상한 초과 413 `VFS_COPY_LIMIT_EXCEEDED`.
    - 목적지 미생성.
  - `destination-parents`: 이동·복사의 명시적 부모 생성 계약.

**관련 계약:**

- `POST /api/v2/namespaces/{namespaceId}/fs/mutations`의 `kind: copy`, `/fs/cp`.

### RQ-027 선택 capability의 설정과 검색

- [x] **진행 상태:** PostgreSQL 및 SQLite 로컬 코드·자동 검증 완료

**요구사항:**

- 기존 파일 API는 기본 활성으로 유지한다.
- VFS-01에서 기존 연산을 끄는 설정은 도입하지 않는다.
- 이후 추가되는 선택 기능은 관련 endpoint를 완결된 capability 단위로 묶어 설정할 수 있어야 한다.
- 전역 설정은 상위 차단으로 작동한다.
- namespace 설정은 전역에서 허용한 기능만 제한하거나 허용한다.
- 전역 차단을 namespace 설정으로 다시 켤 수 없다.
- 새 선택 기능은 명시적으로 활성화하기 전까지 비활성이다.
- 기능 비활성화는 그 기능이 이미 저장한 데이터를 삭제하거나 감추지 않는다.
- 기존 데이터의 안전한 조회·내보내기·복구·삭제는 계속 가능해야 한다.
- 비활성 기능 요청은 안정적인 `VFS_FEATURE_DISABLED` 오류로 거부한다.
- 소비자는 활성 capability 조회 API로 활성 ID를 확인할 수 있다.
- 설정은 서비스 시작 시 적용한다.
- 각 capability 요구사항은 적용 범위, 기본값, 전역/namespace 우선순위, 의존성, 비활성 응답, 기존 데이터 처리, 조회 노출을 명시한다.
- 운영 중 설정 변경은 현재 제공하지 않는다.
- 조회 API는 설정 snapshot의 실제 활성 ID만 반환한다.

**수용 조건:**

- 새 선택 기능이 capability 경계 밖으로 부분 활성화되지 않고, namespace 설정으로 전역 차단을 우회할 수 없다.
- 비활성화 뒤에도 기존 데이터 보존 조건을 지키며, 소비자는 안정된 오류 코드와 활성 상태 조회로 비활성 이유를 판별할 수 있다.

**판정 근거:**

- 시작 JSON 설정과 namespace 존재 검증, 정적 registry·전역/namespace 활성 판정·의존성 검증, 409 `VFS_FEATURE_DISABLED`와 조건부 receipt 경계가 구현되어 있다.
- `GET /api/v2/namespaces/{id}/capabilities`는 서비스 Bearer 인증 아래 ACTIVE namespace의 실제 활성 선택 ID(의존 ID 포함)를 사전순으로 반환하며 빈 registry에서는 빈 배열을 반환한다.
- 설정 환경 변수와 조회 계약은 README·`.env.example`·OpenAPI에 공개되어 있다.
- PostgreSQL과 SQLite 통합 검증에서 `resumable-upload`로 파일을 완료한 뒤 비활성 설정으로 재시작하고, capability 목록에서 ID가 빠진 상태에서도 기존 VFS `stat` 및 `content` API가 동일한 파일 ID·revision·바이트를 반환함을 확인했다.
- 운영 배포 설정과 별도 실소비자 검증은 포함하지 않는다.
- 상세 설계는 [VFS capability 설계](../design/06-vfs-capabilities.md)를 참고한다.
- SQLite 계약 검증에서 다음 계약이 통과했다:
  - `capability-default-off`: 설정 없이는 활성 목록이 비어 있고 feed 요청이 409 `VFS_FEATURE_DISABLED`이며 파일 API는 동작.
  - `capability-discovery`:
    - 전역과 namespace에 허용한 namespace만 `["change-feed"]` 조회.
    - 허용한 namespace의 feed 활성화.
    - 허용하지 않은 namespace는 빈 목록·409·파일 API 동작.
- `upload-session-capability`와 `upload-session-lifecycle`이 `resumable-upload`의 활성 경계를 확인했다.
  - `upload-session-capability`:
    - `resumable-upload` 프로필: 허용한 namespace만 활성 목록에 `resumable-upload` 포함.
    - 허용한 namespace의 세션 생성 가능.
    - 허용하지 않은 namespace는 빈 목록·세션 생성 409 `VFS_FEATURE_DISABLED`이고 파일 API는 동작.
  - `upload-session-lifecycle`:
    - 취소된 세션의 조각 추가·완료는 409 `VFS_UPLOAD_SESSION_CLOSED`.
    - 없는 세션과 다른 namespace의 세션은 구분되지 않는 404.
- 계약은 설정 변경 재시작 뒤 기존 데이터 보존, 미등록 ID·잘못된 설정 파일의 시작 거부, capability 비활성화 뒤 기존 세션의 조회·완료를 다루지 않는다.

### RQ-028 업로드 전체 checksum 검증

- [x] **진행 상태:** 로컬 코드·자동 검증 완료

**요구사항:**

- 호출자는 raw 조건부 업로드의 선택적 `X-Content-Sha256` 또는 재개 업로드 세션 생성의 선택적 `sha256`으로 전체 파일의 SHA-256을 지정할 수 있어야 한다.
- 값은 정확히 64자리 소문자 hex다.
- ENCRYPTED namespace도 저장 전 평문 바이트를 기준으로 한다.
- checksum을 생략한 기존 요청은 계속 처리한다.
- 잘못된 표현은 raw 본문 소비·receipt 생성 또는 재개 세션 생성 전에 `400 VFS_INVALID_CHECKSUM`으로 거부해야 한다.
- 계산값과 다르면 `422 VFS_CHECKSUM_MISMATCH`다.
- 불일치 시 파일 바이트·revision을 바꾸지 않아야 한다.
- 기대값·계산값을 노출해서는 안 된다.
- raw의 422 receipt는 본문 해시와 기대 checksum에 결합해 동일 key의 동일 요청에서 재생한다.
- 재개 생성 fingerprint도 checksum에 결합한다.
- 재개 완료 불일치는 `FAILED`와 최초 422 결과를 보존해 반복 완료에서 재생하고, 상태 조회는 `failure.code`만 공개한다.
- 실패 세션 결과는 종결 뒤 최소 30일 보존하며, staging 객체는 삭제 확인 전까지 임시 사용량에 포함한다.

**수용 조건:**

- 평문·ENCRYPTED namespace에서 정상 checksum은 완료되고 불일치는 기존 파일·revision을 유지한다.
- malformed 입력, key 재사용·결과 재생, FAILED 상태 조회, 30일 보존과 조각 정리·사용량 회계를 PostgreSQL 및 SQLite 검증에서 확인한다.

**판정 근거:**

- raw 조건부 업로드와 재개 업로드에 checksum 입력·평문 SHA-256 비교·불일치 보존 결과가 구현됐다.
- raw 집중 검증과 PostgreSQL 2 suites/23 tests, SQLite 3 suites/41 tests의 선택 L1 근거가 있다.
- 마지막 기존 파일 보존 단언 보강 뒤 `upload-session-finalize.integration-spec.ts`와 SQLite 대응 spec을 각각 20/20 통과했다.
- 최종 L0는 통과했다.
- 최종 PostgreSQL L2는 33 suites/485 tests, SQLite L2는 19 suites/286 tests 통과했다.
- 최초 PostgreSQL 전체 실행 중 기존 short-lease 사례 1건이 400으로 실패했으나 단독·파일 전체 재실행에서는 재현되지 않았고, 후속 전체 L2는 통과했다.
- 원인은 특정하지 않았다.
- 운영 배포 활성화와 소비자 연동은 검증 범위에서 제외한다.
- SQLite 계약 검증에서 `upload-checksum`이 통과했다.
  - 정상 checksum 저장.
  - 불일치 422 `VFS_CHECKSUM_MISMATCH`의 기존 파일·revision 유지와 기대값·계산값 비노출.
  - 같은 key 재전송의 최초 422 재생.
  - 새 경로 미생성.
  - 대문자·짧은 값 등 형식 오류 400 `VFS_INVALID_CHECKSUM`.
- `upload-session-checksum`도 통과했다.
  - `resumable-upload` 프로필: 재개 업로드의 틀린 checksum은 완료가 422 `VFS_CHECKSUM_MISMATCH`이고 기존 파일·revision이 유지되며 새 경로에 부분 파일이 없고.
  - 반복 완료는 최초 422 본문·`X-Request-Id` 재생.
  - 상태는 `FAILED`와 `failure.code`만 공개.
  - 기대값·계산값 미노출.
  - 종결 세션의 조각 추가·취소는 409 `VFS_UPLOAD_SESSION_CLOSED`이고.
  - 같은 생성 key는 최초 201(`OPEN`)을 재생하고 checksum만 바꾼 같은 key는 409이고.
  - 형식 오류는 400 `VFS_INVALID_CHECKSUM`.
  - 바른 checksum의 새 세션은 파일을 교체.
- 계약은 ENCRYPTED namespace, 실패 세션의 30일 보존·조각 정리·사용량 회계를 다루지 않는다.

### RQ-029 namespace 변경 feed

- [x] **진행 상태:** 구현·공개 계약 및 PostgreSQL/SQLite 로컬 검증 완료

**요구사항:**

- 호출자는 cursor 없이 먼저 checkpoint를 발급받고 기존 `ls` API로 namespace 전체를 열거한 뒤 checkpoint 이후의 변경을 재생할 수 있어야 한다.
- 열거 중 목록 cursor가 무효화되면 checkpoint를 보존하고 열거를 다시 시작한다.
- 기존 파일 바이트 이력은 feed가 제공하지 않으며 변경된 파일의 현재 상태를 다시 읽는다.
- 성공한 파일·디렉터리 mutation과 journal 항목은 같은 DB transaction에서 확정된다.
- namespace별 `sequence`는 커밋 순서로 증가한다.
- 한 transaction의 같은 노드는 최초·최종 상태를 비교해 net 이벤트 하나만 낸다.
- 이벤트는 `created`·`updated`·`moved`·`deleted`다.
- 이동 이벤트는 이전 경로를 제공한다.
- 삭제 이벤트는 마지막 경로를 제공한다.
- subtree 이동·복사·재귀 삭제는 영향받은 노드별로 기록하고 snapshot 생성·목록·삭제는 제외한다.
- snapshot 복원으로 파일이 바뀌면 `updated`를 기록한다.
- 각 이벤트의 `operationId`·`operationIndex`·`operationCount`는 같은 transaction의 항목을 묶는다.
- 페이지는 transaction 중간에서 끝날 수 있다.
- 소비자는 응답 변경의 적용과 `nextCursor` 저장을 원자적으로 수행하고, 재조회 시 `sequence`로 중복을 제거한다.
- 빈 페이지의 cursor는 polling에 재사용한다.
- 기본 limit는 100이다.
- 최대 limit는 1000이다.
- `hasMore`는 조회 시점의 다음 페이지 존재 여부다.
- 잘못되거나 다른 namespace의 cursor는 400 `VFS_INVALID_CURSOR`다.
- 보존 경계 이전 cursor는 410 `VFS_CHANGE_CURSOR_EXPIRED`다.
- 만료 시 새 checkpoint를 발급받아 전체 열거부터 재동기화한다.
- `change-feed` capability는 기본 비활성이다.
- 비활성 요청은 409 `VFS_FEATURE_DISABLED`다.
- 최초 checkpoint 뒤에는 capability가 꺼져도 journal 기록을 계속해 재활성화 후 보존 기간 안의 cursor를 유지한다.
- 기본 보존 기간은 30일이다.
- GC는 DB 시각으로 오래된 이벤트와 경계를 같은 transaction에서 정리한다.

**수용 조건:**

- PostgreSQL·SQLite에서 초기 checkpoint와 mutation 경합에도 열거와 재생 사이 변경이 누락되지 않는다.
- 성공·롤백·다중 연산의 net 이벤트, subtree tombstone, operation metadata, 페이지 재조회·polling, capability off/on, cursor 오류·만료, GC/page 경합과 namespace 삭제 정리를 검증한다.

**판정 근거:**

- `GET /api/v2/namespaces/{namespaceId}/fs/changes`, namespace별 journal·checkpoint·cursor·GC와 OpenAPI 계약을 PostgreSQL·SQLite L1/L2에서 확인했다.
- PostgreSQL 전체 L2 첫 실행은 36 suites/514 tests 중 34 suites/504 tests 통과, VFS node·receipt 2 suites 실패였다.
- 하위 시작 디렉터리 ID 회귀를 수정한 뒤 실패 suite 2개를 재실행해 131/131 통과했다.
- receipt의 retry-after 60초 기대값이 첫 실행에서 61초로 나온 1회성 차이는 재실행에서 재현되지 않았다.
- SQLite L2는 22 suites/307 tests, API unit은 88 suites/875 tests 통과했고 typecheck·lint·build도 통과했다.
- 실제 운영 활성화, 소비자 동기화 및 production 복구는 확인하지 않았다.
- SQLite 계약 검증(프로필 `change-feed`)에서 다음 계약이 통과했다:
  - `change-feed-replay`:
    - cursor 없는 호출의 빈 checkpoint.
    - 생성·교체·이동·삭제의 sequence 오름차순 재생과 moved의 `previousPath`·deleted의 마지막 경로·live 이벤트의 `revision`.
    - `operationId`별 `operationIndex`·`operationCount` 일관성.
    - 같은 cursor의 재조회와 limit 분할 재조회 동일.
    - 빈 페이지의 cursor 유지.
    - 재시작 뒤 재생 동일.
  - `change-feed-subtree`:
    - subtree 복사·이동·재귀 삭제의 노드별 이벤트.
    - snapshot 생성·조회·목록·삭제의 무이벤트.
    - 복원의 `updated`.
  - `change-feed-cursor-errors`: 잘못된·변조된·다른 namespace cursor의 400 `VFS_INVALID_CURSOR`.
- 부모·루트 디렉터리의 `updated` 이벤트도 함께 기록된다.
- 계약은 410 `VFS_CHANGE_CURSOR_EXPIRED`, GC, 초기 checkpoint와 mutation 경합, capability off/on 전환, net 이벤트 병합, namespace 삭제 정리를 다루지 않는다.

**관련 계약:**

- [변경 feed 설계](../design/08-namespace-change-feed.md), `GET /api/v2/namespaces/{namespaceId}/fs/changes`, `GET /api/v2/namespaces/{namespaceId}/fs/ls`, `STORIX_VFS_CHANGE_RETENTION_DAYS`.

### RQ-030 namespace 관리자 삭제

- [x] **진행 상태:** PostgreSQL·SQLite 로컬 구현·통합·공개 계약 검증 완료

**요구사항:**

- 관리자 key만 namespace 전체 삭제를 접수할 수 있어야 한다.
- `POST /api/v2/admin/namespaces/{namespaceId}/delete`는 본문 없는 요청과 `Idempotency-Key`를 받고 202·상태 조회 `Location`을 반환한다.
- 같은 namespace ID·key의 재전송은 최초 응답을 재생한다.
- 상태는 관리자 `GET /api/v2/admin/namespaces/{namespaceId}/deletion`으로 조회한다.
- DELETING 접수 커밋 뒤 데이터 읽기·쓰기·PUBLIC·snapshot·trash·feed·upload 경로와 기존 변경 receipt 재생을 `404 NAMESPACE_NOT_FOUND`로 차단해야 한다.
- 이름은 이 커밋부터 새 생성 key·새 namespace ID로 재사용할 수 있어야 한다.
- 기존 생성 receipt와 다른 namespace의 데이터는 유지한다.
- GC는 live·snapshot·trash·upload와 추적 object·staging을 재시작 가능한 단계로 정리해야 한다.
- DELETED는 추적 데이터 정리가 끝나고 counter·usage가 0임을 뜻한다.
- 미정착 PUT는 접근 차단 상태에서 완료를 보류한다.
- 삭제 상태·receipt·namespace tombstone·audit는 유지한다.
- metadata 없는 object·backup·과거 object 버전·외부 cache는 완료 판정에서 제외한다.

**수용 조건:**

- PostgreSQL·SQLite에서 관리자 인증·입력 오류·202/200 receipt·상태 조회·잠금 안 writer와 upload admission 차단·접근 404·이름 재사용·격리를 검증한다.
- 배치·manifest·Blob 참조·counter·global/namespace usage·늦은 PUT·GC 재시작·grace·삭제 실패 재시도·완료 보류·DELETED 전환을 검증한다.
- 공개 계약은 관리자 전용 접수·재생·stat/content 차단·DELETING 조회·새 namespace ID 생성·다른 namespace 보존을 확인한다.
- 전달 중 스트림의 즉시 중단과 기존 presigned URL 취소는 보장하지 않는다.

**판정 근거:**

- 관리자 삭제 접수·상태 조회·접근 차단·영속 GC 정리를 구현했다.
- PostgreSQL L2 API는 38 suites/661 tests 중 37 suites/660 tests가 통과했고 contract runner integration은 8/8 통과했다.
- SQLite L2는 25 suites/435 tests가 통과했다.
- 두 DB 공개 계약은 각각 66/66 통과했다.
- `public-namespace-boundary`는 삭제 접수 뒤 PUBLIC namespace의 공개 경로 조회도 404 `NAMESPACE_NOT_FOUND`로 막히고 다른 namespace는 그대로임을 확인했다.
- PostgreSQL L2에서 `s3-blob-storage.integration-spec.ts`의 arrayBuffers가 103,848,940 bytes로 96 MiB 상한을 넘었으나 실패 spec 단독 재실행은 13/13 통과했다.
- 운영 배포·소비자 연동·백업 복원은 확인하지 않았다.

**관련 계약:**

- [namespace 관리자 삭제 설계](../design/13-namespace-deletion.md), api ADR-0032, `namespace-deletion` 공개 계약.

## 5. Namespace 설정과 사용량

### RQ-031 Namespace ID와 선택 이름

- [x] **진행 상태:** PostgreSQL·SQLite 로컬 통합·공개 계약 검증 완료

**요구사항:**

- Namespace ID는 기존 UUID 형식과 선택 prefix를 가진 UUID v4 형식을 지원한다.
- name은 생략 가능하며 `null`을 반환한다.

**수용 조건:**

- ID 참조·cursor·capability·resumable upload·삭제 경로가 새 형식을 정확히 유지하고 다른 ID 계약은 유지한다.
- migration 뒤 기존 namespace를 조회·변경할 수 있다.

### RQ-032 Namespace별 폴더·node 상한

- [x] **진행 상태:** PostgreSQL·SQLite 로컬 통합 검증 완료

**요구사항:**

- 폴더별 직접 자식 FILE 수를 namespace counter로 유지한다.
- namespace root를 제외한 live node 수도 namespace counter로 유지한다.
- default·ceiling·override를 적용한다.

**수용 조건:**

- mutation·복구·GC의 counter delta, 제한 거부와 rollback이 counter 및 실제 행을 일치시킨다.
- 제한 판정에서 요청별 전체 COUNT를 수행하지 않는다.

### RQ-033 Quota 구성요소와 제외 정책

- [x] **진행 상태:** PostgreSQL·SQLite 로컬 통합 검증 완료

**요구사항:**

- live·trash·snapshot 바이트 합계를 조회한다.
- trash·snapshot 제외 플래그를 지원한다.
- retained trash byte cap을 지원한다.

**수용 조건:**

- 네 제외 조합에서 조회와 검사 대상이 일치한다.
- 구성요소별 증가·감소 delta를 검사하고 cap 하향 시 기존 항목을 삭제하지 않는다.

### RQ-034 Namespace 설정 관리 API

- [x] **진행 상태:** PostgreSQL·SQLite HTTP 통합 및 공개 계약 검증 완료

**요구사항:**

- 관리자 전용 PATCH API에서 quota·FILE 크기·폴더 FILE 수·live node 수·retained trash bytes 및 boolean 정책을 부분 변경한다.
- 변경은 ACTIVE 재확인, ceiling 검증, idempotency receipt 저장과 원자적이어야 한다.

**수용 조건:**

- 필드 validation·권한·ceiling·부분 갱신·reset·동일 key 재생·다른 요청 충돌·삭제 경합을 PostgreSQL·SQLite에서 확인한다.

## 소비자 어댑터 책임과 범위 제외

- 최종 사용자 인증, 프로젝트 ACL, 사용자·프로젝트와 namespace의 연결, 허용 경로 결정은 호출 서버 책임이다.
- 소비자별 파일 파싱·검증·입력 정규화 여부·사용자 오류 문구는 소비자 어댑터 책임이다.
- Storix는 JSON이 아닌 파일도 저장할 수 있어야 한다.
- Jupyter 어댑터에서는 `nbformat` 지원 범위, Jupyter Contents API 경로·상태 코드·응답 모양, 체크포인트 응답 변환과 WAS 자체 응답 재생을 어댑터가 책임진다.
- 셀 실행, 커널 관리, 렌더링, 셀 단위 병합, 노트북 신뢰 서명은 Storix 범위에서 제외한다.

## 관련 문서

- [소비자 요구와 Storix 계약](../design/03-consumer-contracts.md): 범용 저장 기능과 호출 서버 어댑터의 책임.
- [Storix 로드맵](../ROADMAP.md): 실행 항목과 이 문서의 RQ ID 연결.
- [Storix OpenAPI](../../apps/api/openapi.yaml): 현재 제공하는 HTTP 계약.
