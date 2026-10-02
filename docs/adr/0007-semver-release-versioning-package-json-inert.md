# 릴리즈 버전은 SemVer를 따르고, `package.json` 4개의 version 필드는 버전 정보로 쓰지 않는다

## 상태

승인됨 (2026-09-09)

## 배경

ADR-0006은 릴리즈 버전의 원천을 git tag(`vX.Y.Z`)와 `CHANGELOG.md`로 정했다.
다음 정책은 `API-03`으로 미뤘다.

- `package.json` 4개(root/api/admin/demo)의 version 필드 동기화.
- 태그의 SemVer 채택 여부.
- breaking change와 버전 증가 규칙의 관계.

이 ADR은 1.0 진입 직전의 버저닝 정책을 확정한다.

## 결정

- 릴리즈 태그(`vX.Y.Z`)는 SemVer를 따른다.
  - `release.yml`의 태그 패턴은 `v[0-9]+.[0-9]+.[0-9]+`다.
  - `CHANGELOG.md`는 Keep a Changelog 형식을 쓴다.
  - 기존 형식에 맞춰 SemVer 규칙을 채택한다.
  - 1.0 이전(0.x)의 MINOR 증가는 breaking change를 포함할 수 있다.
  - 1.0 이후의 breaking change는 MAJOR를 증가시킨다.
- 당시 `package.json` 4개의 version 필드는 버전 정보로 쓰지 않는다.
  - 대상은 root `storix`, `@cp949/storix-api`, `@cp949/storix-admin`, `@cp949/storix-demo`다.
  - 모두 `private: true`다.
  - 당시 툴체인은 이 필드를 소비하지 않는다.
  - pnpm workspace 의존은 버전 range가 아닌 이름을 기준으로 한다.
  - 실익이 없는 동기화 규칙은 만들지 않는다.
  - release 절차도 이 필드를 갱신하지 않는다.
- CHANGELOG의 breaking change 항목에는 `**BREAKING**:` 접두사를 붙인다.
  - Keep a Changelog 카테고리(`Added`/`Changed`/`Removed` 등)는 유지한다.
  - MAJOR 번호만으로는 릴리즈 안의 breaking 항목을 구분할 수 없다.

## 결과

- `release.md`/`release.yml`은 계속 `package.json`을 변경하지 않는다.
- 새 breaking change에는 `**BREAKING**:` 마커를 반드시 붙인다.
  - 자동 검증은 없다.
  - 작성자가 직접 확인한다.
- HTTP 계약의 breaking 기준과 API 경로의 버전 반영은 api 컨텍스트에서 결정한다.
  - 근거는 api ADR-0020(`apps/api/docs/adr/0020-api-contract-breaking-change-v1-v2-replace.md`)이다.
