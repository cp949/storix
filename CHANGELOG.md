# Changelog

이 문서는 Storix(고객당 단일 인스턴스로 배포되는 `apps/api` 제품)의 주목할 만한
변경사항을 기록한다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를
따른다. `[Unreleased]`를 버전 섹션으로 바꾸는 시점의 태그(`vX.Y.Z`)가 그 버전을
릴리즈한다(`docs/deployment/release.md`). `package.json` 버전과의 동기화 정책은
아직 없어(`API-03`) 이 문서의 버전 번호가 지금은 유일한 근거다.

## [Unreleased]

### Added

- OpenAPI 스펙 초안(`apps/api/openapi.yaml`) — namespace/fs API 계약 문서(`API-01`)
- 태그 push(`vX.Y.Z`) 트리거 릴리즈 워크플로 — CHANGELOG 섹션 추출 + GHCR
  이미지 배포(`API-02`)
- 버저닝/breaking-change 정책 — 릴리즈 태그는 SemVer, breaking change는
  `/api/v1` → `/api/v2` 전체 교체(병행 노출 없음)로 표현(`API-03`,
  `docs/adr/0007`, `apps/api/docs/adr/0020`)

## [0.1.0] - 2026-09-08

첫 항목이라 과거 커밋 이력 전체 대신, 이 시점까지 쌓인 기능을 baseline으로
요약한다.

### Added

- 파일시스템식 API: namespace 생성, 디렉터리/파일 CRUD, 경로 조작
- `mv`/`rm`/`cp`를 Blob-level Copy-on-Write로 지원
- 참조가 0이 된 Blob의 grace period 기반 GC
- 구조화 로깅 + `requestId`
- 서비스 간 인증(API 키 슬라이스, 무중단 로테이션)
- namespace별 리소스 상한 오버라이드, 요청 본문 크기 상한
- `ENCRYPTED` namespace 콘텐츠 암호화(AES-256-CTR)
- 감사 로그(요청 단위 접근 기록)
- CI 취약점 관리 게이트(의존성 audit + 컨테이너 이미지 스캔)
- S3/MinIO/VersityGW 커스텀 엔드포인트 지원
- Presigned download URL 발급
- nginx reverse-proxy 샘플 구성
- 메트릭(Prometheus)/에러 리포팅(Sentry)
- 백업/복구 절차(Postgres 스냅샷 + 스토리지 미러)
- `app` 컨테이너 healthcheck
- 업그레이드 절차 문서(`docs/deployment/upgrade.md`)

### Changed

- 저장소를 Turborepo + pnpm 모노레포로 전환(`apps/api`/`apps/admin`/`apps/demo`)
- 환경변수를 벤더중립 `STORAGE_*`로, 이후 전체를 `STORIX_*` 접두어로 통일
- compose 구성을 백엔드 중립 base + 백엔드별 override 구조로 재구성
- 헬스체크 응답 키를 `minio`에서 `storage`로 변경

### Fixed

- 업로드 상한 등 한도값 환경변수 미설정 시 fallback 동작을 명시적 기본값
  적용으로 통일(이전엔 파일 크기 상한이 빈 값일 때 1바이트로 좁혀지는 결함)
