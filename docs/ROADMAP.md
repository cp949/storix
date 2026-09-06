# Storix 로드맵

작성일: 2026-09-06

각 실행 항목은 `[기둥코드]-NN` ID를 가진 체크박스로 표기한다. 완료되면
체크하고, 커밋/PR에서 `SEC-02` 같은 ID로 참조한다. 설정값·버전처럼 체크 대상이
아닌 확정 사항은 일반 목록으로 둔다.

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
4. **배포/온보딩 + API 계약 고정**: `DEPLOY-01`~`DEPLOY-06`, `API-01`~`API-03`.
   apps/demo로 API 모양이 검증된 뒤 스펙과 버저닝을 고정한다 — 먼저 고정하면
   demo 피드백으로 다시 깨야 한다.
5. **apps/admin**: 가장 나중에 착수한다. 화면 설계는 별도 세션에서
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
│   ├── api/          @storix/api   — 기존 NestJS 서버. CONTEXT.md, docs/adr/ 포함
│   ├── admin/        @storix/admin — 보안/로그 관제 UI. Vite 8 + React 19
│   └── demo/         @storix/demo — api 연동 레퍼런스 예제. Vite 8 + React 19
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
- [x] MONO-02: 기존 서버 코드를 `apps/api`(`@storix/api`)로 이동
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
      policy를 `EncryptedBlobStorage` decorator로 실제 구현.
- [ ] SEC-04: **감사 로그** — 누가/언제/어떤 namespace·파일에 접근했는지 기록.
      현재의 구조화 로깅(티켓 08)은 운영 디버깅용이며 감사 로그와 목적이
      다르다.
- [ ] SEC-05: **취약점 관리 프로세스** — CI에 `npm audit` 또는
      `osv-scanner`(의존성) + Trivy(컨테이너 이미지) 스캔을 필수 게이트로
      추가. CRITICAL/HIGH 발견 시 빌드 실패시킨다. `SECURITY.md`에 신고 접수
      채널만 명시(장문 불필요).

## 2. 스토리지 백엔드 일반화

S3, MinIO, VersityGW를 각각 다른 백엔드로 구현하지 않는다. 셋 다 S3 API를
말하므로, MinIO 구현체에 커스텀 엔드포인트(`Endpoint`, path-style 옵션)를
설정으로 노출하는 것으로 끝난다(imgproxy의 s3 백엔드 구조 참고). 기존
`BlobStorage` 인터페이스는 유지한다. 별도 어댑터 계층은 만들지 않는다.

- [ ] STORAGE-01: MinIO 구현체에 커스텀 엔드포인트 설정(`Endpoint`,
      path-style 옵션) 노출 — S3/MinIO/VersityGW 공통 지원
- [ ] STORAGE-02: **Presigned download URL 발급** — `BlobStorage`에 presigned
      URL 메서드를 추가한다. 내부 통신용 `MINIO_ENDPOINT`와 외부에서 접근
      가능한 `MINIO_PUBLIC_ENDPOINT`를 분리해 설정한다(같은 값을 쓰면 서명된
      URL의 host가 내부 전용 이름이 되어 외부에서 못 찾는다). 발급 API는
      `SEC-01` 인증을 거친다.
- [ ] STORAGE-03: **nginx reverse-proxy 샘플** — `docker-compose`에 nginx
      서비스를 추가해 "공개 도메인 → nginx → 내부 MinIO" 패턴을 재현·검증한다.
      `Host` 헤더와 쿼리스트링을 그대로 통과시켜 presigned 서명이 깨지지
      않게 설정하고, 운영 배포 시 참조용 샘플 구성으로 문서화한다.

## 3. 운영 성숙도

- [ ] OPS-01: **메트릭/에러 리포팅** — 프로바이더 하나를 고정하는 대신, 공통
      인터페이스 + 활성화 목록 구조로 설계해 Prometheus/OTel 등 여러 개를
      동시에 켤 수 있게 한다(imgproxy `monitoring/`, `errorreport/` 패턴
      참고).
- [ ] OPS-02: **백업/복구** — Storix는 Postgres(metadata) + MinIO(object)
      양쪽에 상태를 가지므로 참고할 기존 사례가 없다 — 별도로 설계해야 한다.

## 4. 배포/온보딩 경험

- [ ] DEPLOY-01: `README.md`에 설치, 환경변수, `docker-compose` profile
      사용법 추가 (핵심 기능 소개는 DEPLOY-06에서 완료).
- [ ] DEPLOY-02: 헬스체크 확장 — 현재 MinIO indicator만 있음, Postgres 등
      추가.
- [ ] DEPLOY-03: 스키마 마이그레이션/업그레이드 경로 문서화.
- [ ] DEPLOY-04: `CHANGELOG.md` 도입 — Keep-a-changelog 스타일
      (Added/Changed/Fixed).
- [ ] DEPLOY-05: **컨테이너 런타임 문서화** — 로컬 개발/테스트는 Podman을
      기본으로 사용한다(팀 선호). 배포 산출물(`Dockerfile`,
      `docker-compose.yml`)은 Docker/Podman 둘 다에서 동작해야 한다 — 현재
      파일은 이미 compose-spec 표준 문법만 사용해 두 런타임과 호환된다
      (BuildKit 전용 문법·`docker.sock` 마운트 없음). 설치 문서에
      Docker/Podman 두 실행 예시를 모두 싣는다.
- [x] DEPLOY-06: `README.md`에 핵심 기능(파일시스템식 API, Blob-level COW)
      소개 작성.

## 5. API 계약 고정

- [ ] API-01: OpenAPI 스펙 작성.
- [ ] API-02: 태그 push(`v1.2.3`) 트리거 릴리즈, CHANGELOG에서 해당 버전
      섹션을 추출해 릴리즈 노트 자동 생성.
- [ ] API-03: 버저닝/breaking-change 정책 수립 — 1.0 직전에 고정한다. 1~4번
      기둥 진행 중 나오는 인터페이스 변경을 반영할 여유를 남기기 위함이다.

## 오픈 이슈

- **admin 앱의 기능 범위**: 자리(`apps/admin`, Vite 8 + React 19)는 확정했으나
  화면/기능 설계는 미정. 별도 세션에서 브레인스토밍.
- **오픈코어 라이선스 모델**: imgproxy는 OSS + Pro(유료 고급기능) 구조다.
  Storix가 이 모델을 따를지는 엔지니어링이 아닌 사업 결정이라 로드맵 범위 밖에
  둔다.
