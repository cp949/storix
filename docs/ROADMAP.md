# Storix 로드맵

작성일: 2026-09-06

각 실행 항목은 `[기둥코드]-NN` ID를 가진 체크박스로 표기한다. 완료되면
체크하고, 커밋/PR에서 `SEC-02` 같은 ID로 참조한다. 설정값·버전처럼 체크 대상이
아닌 확정 사항은 일반 목록으로 둔다.

범용 Storix 파일 저장 계약은
[요구사항 문서](./requirements/file-storage.md)의 `RQ-001`~`RQ-029`에서
관리한다. `RQ-NNN`은 수용 조건의 ID이며, 이 로드맵의 실행 항목 ID와는 구분한다.

## 목표

Storix를 사내 전용 서버에서 **고객이 자기 인프라에 self-host하는 독립 제품**으로
성숙시킨다. 배포 단위는 고객별 단일 인스턴스이며, 멀티테넌트 SaaS는 목표 범위가
아니다.

## 현재 상태

티켓 01~08 완료: namespace 라이프사이클, 디렉터리 구조 조작, 콘텐츠
업로드/다운로드, mv/rm/cp(Blob-level COW), orphan Blob GC, 구조화 로깅 +
requestId.

모노레포 전환(`MONO-01`~`MONO-07`) 완료: `apps/api`·`apps/admin`·`apps/demo`·
`packages/` 구조로 전환, pnpm + Turborepo 도입, `Dockerfile` 베이스 이미지를
Node 엔진 하한(`>=24.18`)에 맞게 갱신. 자세한 내용은 아래 "0. 저장소 구조
전환" 체크리스트 참고.

확인된 갭:

- 호출 서버 ↔ Storix 간 서비스 인증 없음
- ADR-0001의 ENCRYPTED 암호화 정책: 설계만 있고 구현 없음
- 감사 로그(누가/언제/어떤 namespace·파일에 접근) 없음
- CI/의존성 취약점 스캔 없음 (`.github` 부재)
- Blob 저장소가 MinIO SDK 구현 하나에 결합

## 실행 순서

기둥 번호(0~5)는 주제별 분류이고, 실제 착수 순서는 다음과 같다.

1. **모노레포 구성**: `MONO-01`~`MONO-07`.
2. **api 하드닝**: `SEC-01`~`SEC-05`, `STORAGE-01`, `OPS-01`. `OPS-02`(백업/복구)는
   apps/demo 사용성 검증을 막지 않으므로 이 단계 필수에서 제외하고 병행·후행
   가능 항목으로 둔다.
3. **apps/demo 구현 및 반복 개선**: 실사용 시나리오로 fs API와 `SEC-01`(서비스
   인증)의 사용성을 검증하고, `STORAGE-02`/`STORAGE-03`(presigned URL + nginx
   reverse-proxy)을 실제로 재현해 검증한다. 발견된 불편함을 api에 반영한다.
4. **배포/온보딩 + API 계약 고정**: `DEPLOY-01`~~`DEPLOY-06`, `API-01`~~`API-03`.
   apps/demo로 API 모양이 검증된 뒤 스펙과 버저닝을 고정한다 — 먼저 고정하면
   demo 피드백으로 다시 깨야 한다.
5. **범용 파일 저장 계약 확장**: `VFS-01`로 요구사항과 기존 OpenAPI 계약을
   정합화하고 capability 설정 후속 항목을 둔 뒤, 소비자 수요와 운영 비용을 근거로
   `VFS-02`~`VFS-07`의 착수 순서를 정한다.
6. **apps/admin**: 가장 나중에 착수한다. 화면 설계는 별도 세션에서
   브레인스토밍한다(오픈 이슈 참고).

## 0. 저장소 구조 전환 (모노레포)

### 배경

현재 소스는 storix API 서버 하나만 상정하고 짜여 있다. 관리자용 보안/로그 관제
화면, API 연동 예제, 향후 CLI/SDK를 같은 저장소에서 관리하려면 먼저 구조를
바꿔야 한다.

### 도구

Turborepo + pnpm workspace. pnpm은 워크스페이스 간 의존성을 엄격히 격리해
`demo`가 `api`의 내부 의존성을 실수로 끌어다 쓰는 것을 방지한다. 현재
`package-lock.json`(npm)에서 `pnpm-lock.yaml`로의 전환은 1회성 기계적 작업이다.

- Node.js 엔진 하한: `>=24.18`
- pnpm: `11`
- TypeScript: `6.0.3`
- ESLint: `v10`
- Prettier: 최신 버전
- 저장소: `https://github.com/cp949/storix` (아직 원격 push 안 함)

### 테스트 러너

`admin`/`demo`(Vite 기반 신규 앱)는 vitest 5.x. `api`는 기존 Jest 설정
(`jest.config.cjs`, `jest.integration.config.cjs`)을 유지하고 vitest로
마이그레이션하지 않는다 — 이미 통과 중인 테스트를 다시 검증해야 하는 비용 대비
얻는 실익(러너 통일)이 낮다. turborepo pipeline은 앱마다 러너가 달라도
`pnpm test` 스크립트 인터페이스만 맞으면 동작하므로 문제없다.

### 구조

```
storix/
├── apps/
│   ├── api/          @cp949/storix-api   — 기존 NestJS 서버. CONTEXT.md, docs/adr/ 포함
│   ├── admin/        @cp949/storix-admin — 보안/로그 관제 UI. Vite 8 + React 19
│   ├── demo1/        보안 최소화 데모 시나리오
│   │   ├── web/      @cp949/storix-demo1-web — api 연동 레퍼런스 예제. Vite 8 + React 19
│   │   └── was/      @cp949/storix-demo1-was — 공개 HTTP API만 쓰는 외부 소비자 WAS
│   └── demo2/        (예정) mTLS 등 풀보안 데모 시나리오 — web/was 동일 구조
├── packages/                        (CLI/SDK 이름 미정 — 결정 시 추가)
├── CONTEXT-MAP.md                   (신규 — 컨텍스트별 CONTEXT.md를 가리킴)
├── docs/adr/                        (시스템 전역 결정만: 모노레포 전환 자체 등)
├── turbo.json
└── pnpm-workspace.yaml
```

### 문서 구조 변경

`docs/agents/domain.md`가 이미 정의한 multi-context repo 패턴을 그대로 쓴다.
루트 `CONTEXT.md`/`docs/adr/`(Namespace, VFS Node, Blob 등 현재 내용)는
`apps/api/CONTEXT.md`, `apps/api/docs/adr/`로 이동하고, 루트에는 컨텍스트 목록을
가리키는 `CONTEXT-MAP.md`를 새로 둔다. `admin`/`demo`는 도메인 용어가 생기기
전까지 컨텍스트 문서를 만들지 않는다.

### 앱별 범위

- **api**: 하드닝 대상. 아래 1~5번 기둥이 전부 이 앱에 적용된다.
- **admin**: 보안/로그 관제 UI. 화면 범위는 미정 — 별도 세션에서 브레인스토밍.
- **demo**: api 연동 예제(예: 간단한 게시판). presigned download URL을 nginx
  reverse-proxy 뒤에서 직접 받는 흐름을 재현해, 운영 배포 시 참조 샘플로
  쓴다. 프로덕션 하드닝 기준 적용 대상 아님.

### 실행 시점

오늘은 방향만 확정한다. 실제 폴더 이동과 빌드 설정은 별도 세션에서 진행하며,
그 시점에 `docs/adr/`에 전환 결정 자체를 ADR로 남긴다.

### 체크리스트

- [x] MONO-01: Turborepo + pnpm workspace 설정(`turbo.json`, `pnpm-workspace.yaml`)
- [x] MONO-02: 기존 서버 코드를 `apps/api`(`@cp949/storix-api`)로 이동
- [x] MONO-03: `CONTEXT-MAP.md` 도입, `CONTEXT.md`/`docs/adr/`를 `apps/api`로 이동
- [x] MONO-04: `apps/admin` 스캐폴딩 (Vite 8 + React 19)
- [x] MONO-05: `apps/demo` 스캐폴딩 (Vite 8 + React 19)
- [x] MONO-06: `packages/` 디렉터리 예약 (CLI/SDK 이름은 이후 확정)
- [x] MONO-07: `Dockerfile` 베이스 이미지를 Node `>=24.18`에 맞게 갱신

## 1. 보안 기반

우선순위 1위. 외부 배포 후 인증 계층을 끼워넣는 것은 배포된 고객 환경마다
마이그레이션이 필요해 비용이 크다.

- [x] SEC-01: **서비스 간 인증** — API key 발급. 키를 슬라이스(현재 키 + 이전
      키)로 관리해 무중단 로테이션을 지원한다(imgproxy
      `IMGPROXY_KEY`/`IMGPROXY_SALT` 패턴 참고).
- [x] SEC-02: **리소스 상한** — namespace별 업로드 크기·전역 JSON/urlencoded 요청 본문 크기 상한. DoS
      방어를 보안 기반 범위에 포함한다.
- [x] SEC-03: **암호화 정책 구현** — ADR-0001에서 설계만 된 `ENCRYPTED`
      policy를 AES-256-CTR(`EncryptingPutTarget` + `getEncrypted`)로 실제 구현.
- [x] SEC-04: **감사 로그** — 누가/언제/어떤 namespace·파일에 접근했는지 기록.
      현재의 구조화 로깅(티켓 08)은 운영 디버깅용이며 감사 로그와 목적이
      다르다.
- [x] SEC-05: **취약점 관리 프로세스** — CI에 `npm audit` 또는
      `osv-scanner`(의존성) + Trivy(컨테이너 이미지) 스캔을 필수 게이트로
      추가. CRITICAL/HIGH 발견 시 빌드 실패시킨다. `SECURITY.md`에 신고 접수
      채널만 명시(장문 불필요).

## 2. 스토리지 백엔드 일반화

S3, MinIO, VersityGW를 각각 다른 백엔드로 구현하지 않는다. 셋 다 S3 API를
말하므로, MinIO 구현체에 커스텀 엔드포인트(`Endpoint`, path-style 옵션)를
설정으로 노출하는 것으로 끝난다(imgproxy의 s3 백엔드 구조 참고). 기존
`BlobStorage` 인터페이스는 유지한다. 별도 어댑터 계층은 만들지 않는다.

- [x] STORAGE-01: MinIO 구현체에 커스텀 엔드포인트 설정(`Endpoint`,
      path-style 옵션) 노출 — S3/MinIO/VersityGW 공통 지원
- [x] STORAGE-02: **Presigned download URL 발급** — `BlobStorage`에 presigned
      URL 메서드를 추가한다. 내부 통신용 `STORIX_STORAGE_ENDPOINT`와 외부에서 접근
      가능한 `STORIX_STORAGE_PUBLIC_ENDPOINT`를 분리해 설정한다(같은 값을 쓰면 서명된
      URL의 host가 내부 전용 이름이 되어 외부에서 못 찾는다). 발급 API는
      `SEC-01` 인증을 거친다.
- [x] STORAGE-03: **nginx reverse-proxy 샘플** — `docker-compose`에 nginx
      서비스를 추가해 "공개 도메인 → nginx → 내부 MinIO" 패턴을 재현·검증한다.
      `Host` 헤더와 쿼리스트링을 그대로 통과시켜 presigned 서명이 깨지지
      않게 설정하고, 운영 배포 시 참조용 샘플 구성으로 문서화한다.

## 2a. 범용 파일 저장 계약 확장

Jupyter 파일 IO에서 정리한 저장 요구를 범용 소비자 관점으로 확장한다. 현재
OpenAPI에 이미 있는 Range 읽기, cursor 기반 디렉터리 목록, 조건부 mkdir/delete/
move/copy는 신규 기능으로 중복 등록하지 않는다. 해당 동작의 요구사항 수용 조건을
정리하고 현재 계약과 수용 조건 사이의 갭을 기록한다. 미정합·미검증은 완료 근거로
표시하지 않는다. 아래 신규 후보는 필요성과 정책을 설계한 뒤 구현한다.

- [x] VFS-01: **기존 파일 API의 요구사항 추적 보강** — `file-storage.md`를
      범용 저장 요구사항으로 재구성하고, Range 읽기·디렉터리 목록·mkdir/delete/
      move/copy를 별도 RQ로 추적해 관련 OpenAPI operation과 수용 조건을 연결했다.
      ID/revision, 목적지 충돌, subtree 원자성, 페이지 cursor 무효화 의미를 정리하고
      현재 계약과 남은 갭·검증 경계를 구분했다. 선택 capability 설정 원칙은 요구사항에
      기록했다. 설정·오류 기반은 `VFS-06`, 활성 상태 조회 API 계약·구현은
      `VFS-07`에서 다룬다.
- [x] VFS-02: **재개 가능한 대용량 업로드** — 현재 raw stream 업로드와 구분되는
      업로드 session 계약을 설계·구현한다. 조각 재전송, 완료 시 원자적 공개,
      동시 완료/중단, 만료·취소, 임시 저장량 한도 및 정리를 포함한다.
      구현과 집중 로컬 검증: PostgreSQL+MinIO 및 SQLite에서 lifecycle·parts·finalize를
      확인했다. 최종 L2는 PostgreSQL+MinIO 33 suites/480 tests, SQLite 19 suites/281 tests를
      통과했다. SQLite 최초 실행은 migration 기대 목록 fixture 1건 실패했고 수정 후 전체 재실행했다.
      기본 비활성 capability와 공개 계약·암호화·GC 경계를 문서화했다.
      프로세스 중단 중 PUT 정착 여부를 증명할 수 없는 예약은 quota 상한을 위해 자동 과금 해제하지 않으며,
      해당 예약이 상한을 소진하면 추가 업로드가 막힐 수 있음을 설계에 명시했다.
      운영 활성화, 배포별 한도 선택, 배포 GC, 여러 API instance의 실제 배치와 실사용
      소비자 검증은 이 로컬 증거에 포함되지 않는다.
- [x] VFS-03: **업로드 checksum 검증** — 호출자가 제공한 전체 콘텐츠 checksum을
      Storix 계산값과 커밋 전에 비교한다. raw 조건부 업로드의 선택적
      `X-Content-Sha256`과 재개 세션 생성의 선택적 `sha256`을 구현했다. 둘 다 저장 전
      전체 평문 바이트의 SHA-256 64자리 소문자 hex이며 ENCRYPTED namespace도 평문 기준이다.
      잘못된 값은 400 `VFS_INVALID_CHECKSUM`, 불일치는 무변경 422
      `VFS_CHECKSUM_MISMATCH`다. raw receipt와 재개 생성 fingerprint는 기대 checksum에
      결합하고, 재개 불일치는 `FAILED` 완료 결과로 30일 이상 재생한다.
      DELTA-01/02의 선택 L1 검증과 마지막 테스트 보강 후 PostgreSQL/MinIO·SQLite finalize spec
      각 20/20 통과를 기록했다. 최종 L0 전체 통과, PostgreSQL/MinIO L2 33 suites/485 tests,
      SQLite L2 19 suites/286 tests 통과를 확인했다. 최초 PostgreSQL/MinIO L2에서 기존
      short-lease 사례 1건이 일시 실패했으나 단독·파일 전체 재실행에서 재현되지 않았고 후속 전체 L2에서 통과했다.
      실패 원인은 특정하지 않았다. 운영 활성화와 실제 소비자 연동 검증은 제외 범위다.
      요구사항 판정은 [RQ-028](./requirements/file-storage.md)을 참고한다.
- [x] VFS-04: **namespace 변경 feed** — 최초 전체 열거와 이후 파일/디렉터리 변경
      동기화를 위한 기본 비활성 `change-feed`와 checkpoint·cursor API를 구현했다.
      namespace 순서의 transaction net 이벤트는 추가·수정·이동·삭제와 tombstone,
      operation 묶음 정보를 담는다. 기본 30일 보존, 410 만료 시 전체 재동기화,
      빈 페이지 polling 및 중복 재생 경계는 [RQ-029](./requirements/file-storage.md)와
      [설계](./design/08-namespace-change-feed.md)를 따른다. PostgreSQL L2는 36 suites 중
      34 suites/504 tests가 첫 실행에서 통과했다. 실패한 VFS node·receipt 2 suites는
      하위 시작 디렉터리 ID 회귀를 수정한 뒤 재실행해 131/131 통과했다. receipt의
      Retry-After 60초 기대값은 첫 실행에서 61초로 어긋났으나 재현되지 않았다.
      SQLite L2 22 suites/307 tests, API L0 88 suites/875 tests, typecheck·lint·build도
      통과했다. 초기 checkpoint/mutation, 같은 namespace 직렬화, namespace별 독립
      sequence를 barrier/shared-spec에서 확인했다. 실제 운영 활성화와 소비자 동기화·복구는 제외한다.
- [x] VFS-05: **revision 이력과 삭제 복구 정책** — 현재 revision은 조건부 변경용
      비교 토큰이고 과거 바이트는 명시적 snapshot으로만 보존한다. 일반 삭제는 FILE 또는
      subtree를 30일 휴지통 manifest로 옮긴다. namespace별 기본 100000 보존 node 상한,
      미만료 목록, 원래 node ID와 새 revision 복구, 관리자 직접 purge, DB 시각 기반 만료
      GC를 구현했다. live·snapshot·purge 전 휴지통 FILE byte를 논리 quota에 합산하고,
      purge는 공유 Blob 참조를 보존한다. [RQ-024](./requirements/file-storage.md)와
      [설계](./design/09-vfs-trash-and-recovery.md)를 따른다. 로컬 focused PostgreSQL
      GC+HTTP 2 suites/167 tests, SQLite GC+HTTP 2 suites/28 tests가 통과했고,
      최종 PostgreSQL/MinIO L2 36 suites/536 tests, SQLite L2 22 suites/326 tests가 통과했다.
      최종 root test는 API 90 suites/891 tests, typecheck·lint·build도 통과했다. 운영 DB migration, 실제 백업 복원,
      외부 consumer/browser/production 연동은 별도 검증 대상이다.
- [x] VFS-06: **선택 capability 설정과 비활성 동작** — 이후 추가되는 선택 기능을 완결된
      capability 단위로 설정한다. 설정 기반은 완료했다: 시작 시 JSON 검증, 정적 registry,
      전역 상한·namespace 명시적 허용, 기본 비활성, 의존성 검증, 409
      `VFS_FEATURE_DISABLED`와 조건부 receipt 재생 경계를 구현했다. 기존 파일 API는
      계속 활성이고 저장 데이터의 조회·내보내기·복구·삭제 경계는 선택 기능 추가 시
      지켜야 한다. 활성 capability 조회 계약·구현은 VFS-07에서 완료했다. 현재
      production registry에는 기본 비활성 `resumable-upload`가 있다. PostgreSQL/MinIO와
      SQLite에서 기능 활성 중 완료한 파일을 재시작 후 비활성 상태에서도 capability 목록에서
      숨기고 기존 VFS `stat`/`content` API로 읽을 수 있음을 검증했다. 세부 근거는
      [RQ-027](./requirements/file-storage.md)을 참고한다. 실제 배포 설정·소비자 검증은 제외한다.
      현재 설계는
      [06-vfs-capabilities.md](./design/06-vfs-capabilities.md)에 기록한다.
- [x] VFS-07: **활성 capability 조회** — `GET /api/v2/namespaces/{id}/capabilities`를
      전역 서비스 Bearer key로 보호하고 ACTIVE namespace에서 실제 활성 선택 ID를
      사전순으로 반환한다. 전역·namespace 허용과 의존성 결과를 기존 활성 판정에 따라
      반영하고, 기본 파일 API는 제외한다. 기본 설정에서 활성 ID가 없으면
      `200 { "capabilities": [] }`이며 `Cache-Control: no-store`다. 잘못된 UUID·없는
      namespace·ACTIVE가 아닌 namespace는 404다. OpenAPI와 route coverage가 같은 계약을 확인한다.
      실제 선택 기능 및 해당 데이터의 비활성화 후 접근 가능성 검증은 포함하지 않는다.
- [x] VFS-08: **namespace 휴지통 opt-out** — 기본 OFF에서 legacy `/fs/rm`·`/fs/rmdir`와
      조건부 delete는 휴지통 manifest 없이 영구 삭제한다. 관리자 PATCH로 namespace별 정책을
      바꾸며, 정책 변경과 삭제는 동일 namespace mutation lock으로 직렬화한다. OFF 전환 뒤에도
      기존 휴지통 항목은 목록·복원·purge 가능하고, 조건부 receipt는 최초 결과를 재생한다.
      PostgreSQL/MinIO·SQLite focused race/receipt/audit 및 OpenAPI 검증을 완료한 뒤 L0/L2
      게이트와 로컬 closeout 판정을 기록한다. 세부 계약은 [RQ-024](./requirements/file-storage.md)와
      [설계](./design/09-vfs-trash-and-recovery.md)를 따른다. 외부 consumer·production 검증은 제외한다.
- [x] VFS-09: **파일 만료와 확정** — 새 FILE 생성 시 만료 지정, `persist` 확정,
      GC 만료 삭제로 미확정 FILE을 Storix가 회수한다. 삭제는 namespace 휴지통 정책을
      따르고 PUBLIC 읽기에서는 만료 예정 FILE을 숨긴다. [설계](./design/10-file-expiry.md)를 따른다.

## 3. 운영 성숙도

- [x] OPS-01: **메트릭/에러 리포팅** — 프로바이더 하나를 고정하는 대신, 공통
      인터페이스 + 활성화 목록 구조로 설계해 Prometheus/OTel 등 여러 개를
      동시에 켤 수 있게 한다(imgproxy `monitoring/`, `errorreport/` 패턴
      참고).
- [x] OPS-02: **백업/복구** — Storix는 Postgres(metadata) + MinIO(object)
      양쪽에 상태를 가지므로 참고할 기존 사례가 없다 — 별도로 설계해야 한다.

WORM/Object Lock은 규제·감사 요구가 구체화될 때 별도 항목으로 검토한다. 범용 파일
저장 기본 계약에는 포함하지 않는다.

## 4. 배포/온보딩 경험

- [x] DEPLOY-01: `README.md`에 설치, 환경변수, `docker-compose` profile
      사용법 추가 (핵심 기능 소개는 DEPLOY-06에서 완료).
- [x] DEPLOY-02: **헬스체크 확장** — `/health/ready`는 최초 커밋부터 이미
      Postgres·스토리지를 함께 검사한다(로드맵 최초 문구 오기, 코드 확인 후
      정정). 남은 갭 두 개를 실제로 채운다: (1) `app` 컨테이너에
      Docker/Podman `healthcheck`가 없어 `compose ps`로 상태를 못 봤음 →
      Node 내장 fetch로 `/health/ready`를 찌르는 healthcheck 추가(curl은
      이미지 축소로 purge됨, 재설치하지 않음). (2) 응답 키가 `minio`로
      고정돼 VersityGW-primary 방향(ADR-0003)과 같은 오독 위험 → `storage`로
      변경(클래스/파일명은 ADR-0016대로 `Minio*` 유지 — minio-js Client 타입
      결합은 그대로이므로).
- [x] DEPLOY-03: **스키마 마이그레이션/업그레이드 경로 문서화** — 자동
      revert는 지원하지 않고 이미지 되돌리기(스키마 불변경)·백업 복구(스키마
      변경)로 롤백 처리(ADR-0017). 범위는 single-instance만이며, 버전 식별은
      태그 릴리즈(`API-02`) 도입 전까지 git 커밋 기준.
- [x] DEPLOY-04: **`CHANGELOG.md` 도입** — Keep a Changelog 형식. 소급 없이
      지금까지의 기능을 `[0.1.0]` baseline으로 요약, 이후는 `[Unreleased]`.
      버전 번호 동기화 정책은 `API-03`으로 미룸. 작성 컨벤션은 `AGENTS.md`,
      CI 강제는 하지 않음.
- [x] DEPLOY-05: **컨테이너 런타임 문서화** — 로컬 개발/테스트는 Podman을
      기본으로 사용한다(팀 선호). 배포 산출물(`Dockerfile`,
      `docker-compose.yml`)은 Docker/Podman 둘 다에서 동작해야 한다 — 현재
      파일은 이미 compose-spec 표준 문법만 사용해 두 런타임과 호환된다
      (BuildKit 전용 문법·`docker.sock` 마운트 없음). 설치 문서에
      Docker/Podman 두 실행 예시를 모두 싣는다.
- [x] DEPLOY-06: `README.md`에 핵심 기능(파일시스템식 API, Blob-level COW)
      소개 작성.

## 5. API 계약 고정

- [x] API-01: **OpenAPI 스펙 작성** — `apps/api/openapi.yaml`(수기 YAML, 초안).
      apps/demo 검증 전에 착수해 `info.version: 0.1.0-draft`로 표시하고,
      demo 피드백에 따른 breaking change 가능성을 열어둔다(ADR-0019).
- [x] API-02: **태그 push(`v1.2.3`) 트리거 릴리즈** — `.github/workflows/release.yml`.
      CHANGELOG에서 해당 버전 섹션을 추출해 릴리즈 노트 생성 + `ghcr.io/cp949/storix`
      이미지 push. `package.json` 버전 동기화는 다루지 않음(ADR-0006, `API-03`으로
      위임). 절차: `docs/deployment/release.md`.
- [x] API-03: **버저닝/breaking-change 정책 수립** — 릴리즈 태그는 SemVer,
      breaking change는 `/api/v1` → `/api/v2` 전체 교체(병행 노출 없음)로
      표현한다(`docs/adr/0007`, `apps/api/docs/adr/0020`). `package.json` 4개의
      version 필드는 버전 정보로 쓰지 않는다. `openapi.yaml`의 초안 문구·1.0
      확정은 `apps/demo` 실사용 검증(로드맵 "실행 순서" 3번, 아직 미완료) 이후로
      유지한다.

## 오픈 이슈

- **admin 앱의 기능 범위**: 자리(`apps/admin`, Vite 8 + React 19)는 확정했으나
  화면/기능 설계는 미정. 별도 세션에서 브레인스토밍.
- **오픈코어 라이선스 모델**: imgproxy는 OSS + Pro(유료 고급기능) 구조다.
  Storix가 이 모델을 따를지는 엔지니어링이 아닌 사업 결정이라 로드맵 범위 밖에
  둔다.
