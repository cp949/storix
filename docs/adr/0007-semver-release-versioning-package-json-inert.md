# 릴리즈 버전은 SemVer를 따르고, `package.json` 4개의 version 필드는 버전 정보로 쓰지 않는다

## 상태

승인됨 (2026-09-09)

## 배경

ADR-0006이 릴리즈 버전의 source of truth를 git tag(`vX.Y.Z`) + `CHANGELOG.md`로
정했지만, `package.json` 4개(root/api/admin/demo)의 version 필드 동기화 정책과
태그 자체의 버전 체계(SemVer 여부·breaking change와 bump 규율의 관계)는
`API-03`으로 명시적으로 미뤄뒀다. 1.0 진입 직전인 지금 이 정책을 확정한다.

## 결정

- 릴리즈 태그(`vX.Y.Z`)는 SemVer를 공식 체계로 삼는다. `release.yml`의 태그
  패턴(`v[0-9]+.[0-9]+.[0-9]+`)과 `CHANGELOG.md`가 이미 따르는 Keep a
  Changelog 포맷이 SemVer를 전제하므로 표준 규율을 그대로 채택한다: 1.0
  이전(0.x)에는 MINOR bump도 breaking change를 포함할 수 있고, 1.0 이후에는
  MAJOR bump만 breaking을 의미한다.
- `package.json` 4개(root `storix`, `@storix/api`, `@storix/admin`,
  `@storix/demo`)는 전부 `private: true`이며 어떤 툴체인도 이 version 필드를
  실제로 소비하지 않는다(pnpm workspace 간 의존은 이름 기준이지 버전 range가
  아니다). 이 필드는 버전 정보로 쓰지 않고, 앞으로도 release 절차가 갱신하지
  않는다 — 지킬 실익이 없는 동기화 규칙을 새로 만들지 않는다.
- `CHANGELOG.md`에서 breaking change 항목은 표준 Keep a Changelog
  카테고리(`Added`/`Changed`/`Removed` 등)를 그대로 유지한 채, 항목 앞에
  `**BREAKING**:` 접두사를 붙인다. MAJOR 번호만으로는 한 릴리즈 안에 여러
  항목이 있을 때 정확히 무엇이 breaking인지 구분할 수 없기 때문이다.

## 결과

- `release.md`/`release.yml`은 이 ADR 이후에도 `package.json`을 건드리지
  않는다 — 변경 없음.
- 새 breaking change를 `CHANGELOG.md`에 적을 때는 `**BREAKING**:` 마커를
  빠뜨리지 않아야 한다(자동 검증 없음, 사람이 직접 챙긴다).
- `apps/api`의 HTTP 계약에서 무엇이 breaking인지, 그리고 그 버전을 API 경로에
  어떻게 반영하는지는 api 컨텍스트 결정이라 별도로
  `apps/api/docs/adr/0020-api-contract-breaking-change-v1-v2-replace.md`에
  남긴다.
