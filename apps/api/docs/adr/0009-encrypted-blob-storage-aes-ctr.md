# 암호화 정책은 AES-256-CTR 기반 EncryptedBlobStorage decorator로 구현한다

ADR-0001에서 설계만 해둔 `ENCRYPTED` 정책(SEC-03)을 구현한다. `BlobStorage` 뒤에
`EncryptedBlobStorage` decorator를 끼우고, 알고리즘은 AES-256-CTR을 쓴다. CTR은
블록 경계 기준으로 임의 오프셋부터 복호화를 시작할 수 있어(오프셋을 16바이트
블록으로 내림 → 그 지점부터 복호화 → 앞쪽 여분 바이트를 버림), 기존
`content.service.ts`의 Range GET(206 Partial Content)이 암호화 여부와 무관하게
동일하게 동작한다. AEAD(GCM 등) 인증 태그는 두지 않는다 — 지금도 다운로드
시점에 무결성 검증을 하지 않으므로(업로드 시점 `Blob.sha256`만 존재) 퇴행이
아니며, 태그를 두면 부분 다운로드 시 인증을 포기하거나 매번 전체 파일을 읽어야
하는 복잡도만 늘어난다.

IV(16바이트, blob마다 랜덤 생성)는 저장 객체에 prepend하지 않고
`blob.encryption_iv`(nullable bytea) 컬럼에 저장한다. `content.service.ts`가
GET/PUT마다 이미 blob 메타 row를 조회하므로 추가 MinIO 왕복 없이 IV를 얻을 수
있고, 저장 객체가 평문과 바이트 수 1:1로 대응해 Range 좌표 계산에 오프셋 보정이
필요 없다.

키는 배포 전체가 공유하는 마스터 키 하나(`ENCRYPTION_MASTER_KEY`, hex 64자)만
쓴다. namespace별 파생 키를 두지 않는다 — Storix의 배포 단위가 고객별 단일
인스턴스(멀티테넌트 아님)라 namespace 간 키 격리의 실익이 낮다(SEC-01/SEC-02와
동일 근거). blob마다 유일한 IV를 쓰므로 CTR의 안전성 요건(키+IV 쌍의 유일성)은
충족된다.

마스터 키 로테이션은 지원하지 않는다. 키를 바꾸려면 ADR-0001의 "정책 변경 =
새 namespace 생성 + 데이터 이전" 경로를 그대로 쓴다. `ENCRYPTION_MASTER_KEY`는
조건부 필수다 — `ENCRYPTED` namespace를 하나도 안 쓰는 배포는 설정하지 않아도
되지만, 설정 없이 `ENCRYPTED` namespace 생성을 요청하면 400으로 거부하고,
부팅 시 DB에 이미 `ENCRYPTED` namespace가 있는데 키가 없으면 부팅 자체를
실패시킨다(fail-closed).

**마스터 키를 분실하면 그 배포의 `ENCRYPTED` namespace 데이터 전부가 영구적으로
복호화 불가능해진다.** 이 리스크는 배포 문서에 명시해야 한다.

## Considered Options

- **AES-256-GCM + encrypted namespace에서 Range 비활성화**: 전체 다운로드에
  한해 태그로 무결성 검증이 가능하지만, 암호화 여부에 따라 API 동작이 달라진다.
  Range는 이 프로젝트의 핵심 기능(README에 명시)이라 정책별로 동작이 갈리는
  비일관성을 감수할 만한 이점이 아니라고 보고 보류했다.
- **Range 요청마다 전체 객체를 버퍼링 후 슬라이스**: 구현은 가장 단순하지만
  `MAX_FILE_SIZE_BYTES` 기본값이 5GiB라 Range 요청 하나가 서버 메모리에 5GiB를
  올릴 수 있어 사실상 배제했다.
- **IV를 저장 객체에 inline prepend**: `blob` 테이블 스키마 변경이 필요 없지만,
  매 GET마다 IV 조회용 왕복이 추가되거나 Range 좌표 계산에 오프셋 보정이 계속
  끼어들어야 해서, 이미 blob 메타를 조회하는 지점에 컬럼 하나 얹는 쪽을
  택했다.
- **namespace별 파생 키(HKDF)**: namespace 하나가 뚫려도 다른 namespace 키가
  안전해지지만, 멀티테넌트가 아닌 배포 모델에서 격리 실익 대비 복잡도가 커서
  보류했다. 이 전제(고객별 단일 인스턴스)가 바뀌면 재검토해야 한다.
- **`API_KEY`처럼 마스터 키 슬라이스(신·구 동시 유효)**: `blob`에 key version
  컬럼이 필요해지는 스키마 확장이라, 로테이션 요구가 실제로 생기기 전까지는
  ADR-0001의 미지원 스탠스를 그대로 따르기로 했다.
