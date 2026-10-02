# 암호화 정책은 AES-256-CTR 기반 put 래퍼 + get 헬퍼로 구현한다

api ADR-0001에서 계획한 `ENCRYPTED` 정책을 구현한다(SEC-03).

## 구현 형태

- 알고리즘은 AES-256-CTR을 사용한다.
- 업로드는 `EncryptingPutTarget` 클래스로 감싼다.
- `EncryptingPutTarget`은 `put`/`delete`를 구현한다.
- 다운로드는 `getEncrypted()` 자유 함수를 사용한다.
- api ADR-0001의 `EncryptedBlobStorage` decorator 계획을 이 형태로 대체한다.

`BlobStorage` 전체를 감싸는 decorator를 쓰지 않는 이유:

- `BlobStorage.put`은 `void`를 반환한다.
- 호출자는 생성된 IV를 받아 `blob` row에 저장해야 한다.
- 기존 인터페이스만 구현하는 decorator로는 IV를 반환할 수 없다.

## Range와 무결성

CTR은 블록 경계부터 복호화를 시작할 수 있다.
Range 복호화 절차:

1. 시작 오프셋을 16바이트 블록 경계로 내림한다.
2. 해당 블록 위치에 맞춘 카운터로 복호화를 시작한다.
3. 요청 시작점 앞의 여분 바이트를 버린다.

이 방식으로 `content.service.ts`의 Range GET(206 Partial Content)을 암호화 여부와 무관하게 유지한다.

AEAD(GCM 등) 인증 태그는 두지 않는다.

- 업로드 시점에는 `Blob.sha256`을 기록한다.
- 이 결정 시점의 다운로드는 무결성을 검증하지 않았다.
- 인증 태그를 생략해도 기존 다운로드의 무결성 검증 수준은 바뀌지 않는다.
- 전체 파일 인증 태그를 쓰면 부분 다운로드 시 인증을 포기하거나 전체 파일을 읽어야 한다.

## IV 저장

- IV는 blob마다 랜덤 생성한 16바이트 값이다.
- IV는 `blob.encryption_iv`(nullable bytea) 컬럼에 저장한다.
- 저장 객체 앞에 IV를 붙이지 않는다.

결정 근거:

- `content.service.ts`는 다운로드와 업로드 시 blob 메타 row를 조회한다.
- IV를 얻기 위한 추가 스토리지 왕복이 필요하지 않다.
- 저장 객체와 평문의 바이트 수가 같다.
- Range 좌표에 IV 길이만큼의 오프셋을 보정할 필요가 없다.

## 마스터 키

- 배포 전체가 마스터 키 하나를 공유한다.
- 키 설정은 `STORIX_ENCRYPTION_MASTER_KEY`(hex 64자)를 사용한다.
- 이 ADR의 기존 키 설정 표기는 `ENCRYPTION_MASTER_KEY`다.
- namespace별 파생 키는 두지 않는다.

결정 근거:

- Storix는 고객별 단일 인스턴스 배포를 전제로 한다.
- 멀티테넌트 배포가 아니므로 namespace 간 키 격리의 실익이 낮다고 판단했다(SEC-01/SEC-02와 동일 근거).
- CTR은 키와 IV 쌍의 유일성을 요구한다.
- blob마다 랜덤 IV를 생성해 IV 재사용을 피한다.

## 키 설정과 로테이션

- 마스터 키 로테이션은 지원하지 않는다.
- 키 변경은 api ADR-0001의 새 namespace 생성과 데이터 이전 경로를 사용한다.
- `STORIX_ENCRYPTION_MASTER_KEY`는 조건부 필수다.
  - `ENCRYPTED` namespace가 없는 배포는 설정하지 않아도 된다.
  - 키 없이 `ENCRYPTED` namespace 생성을 요청하면 400으로 거부한다.
  - DB에 `ENCRYPTED` namespace가 있는데 키가 없으면 부팅을 실패시킨다(fail-closed).

**마스터 키를 분실하면 해당 배포의 모든 `ENCRYPTED` namespace 데이터를 영구적으로 복호화할 수 없다.**
이 위험은 배포 문서에 명시한다.

## Considered Options

- **AES-256-GCM과 encrypted namespace의 Range 비활성화**
  - 전체 다운로드는 인증 태그로 무결성을 검증할 수 있다.
  - 암호화 여부에 따라 API 동작이 달라진다.
  - Range는 README에 명시한 핵심 기능이다.
  - 정책별 동작 차이를 감수할 이점이 부족하다고 판단해 보류했다.
- **Range 요청마다 전체 객체를 버퍼링한 뒤 슬라이스**
  - 구현은 단순하다.
  - 이 결정 시점의 `MAX_FILE_SIZE_BYTES` 기본값은 5GiB다.
  - Range 요청 하나로 서버 메모리에 5GiB를 올릴 수 있어 배제했다.
- **저장 객체 앞에 IV 추가**
  - `blob` 테이블 스키마를 바꾸지 않아도 된다.
  - 매 GET에 IV 조회용 왕복을 추가하거나 Range 좌표를 보정해야 한다.
  - 이미 조회하는 blob 메타에 IV 컬럼을 두는 방식을 택했다.
- **namespace별 파생 키(HKDF)**
  - namespace별 키 격리가 가능하다.
  - 단일 인스턴스 배포에서는 격리 실익보다 복잡도가 크다고 판단해 보류했다.
  - 고객별 단일 인스턴스 전제가 바뀌면 재검토한다.
- **`API_KEY`처럼 신·구 마스터 키 동시 허용**
  - `blob`에 key version 컬럼이 필요하다.
  - 로테이션 요구가 생기기 전까지는 api ADR-0001의 미지원 결정을 유지한다.
