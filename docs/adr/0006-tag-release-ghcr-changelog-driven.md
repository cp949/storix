# 태그 릴리즈는 `package.json` 버전과 무관하게 git tag + CHANGELOG만으로 동작한다

API-02(태그 push 트리거 릴리즈)를 구현하며 세 가지를 결정했다.

1. **버전의 source of truth는 git tag(`vX.Y.Z`)와 `CHANGELOG.md`의 `## [X.Y.Z]` 섹션뿐이다.**
   `package.json` 4개(root/api/admin/demo)의 `version` 필드는 읽지도, 검증하지도,
   갱신하지도 않는다. 이 필드들 사이의 동기화 정책은 `API-03`(버저닝/breaking-change
   정책, "1.0 직전")으로 의도적으로 미뤄져 있고(`DEPLOY-04`), 릴리즈 워크플로가
   먼저 그 정책을 확정해버리면 API-03의 선택지를 좁힌다.
2. **이미지는 GHCR(`ghcr.io/cp949/storix`)에 배포한다.** 저장소가 public이라 공개
   패키지에 별도 비용·시크릿 설정이 필요 없고, 내장 `GITHUB_TOKEN`으로 인증한다.
3. **태그가 가리키는 커밋이 `origin/main`의 조상이 아니면 릴리즈를 중단한다.**
   `dev`나 작업 브랜치에 실수로 남은 태그가 public 이미지·릴리즈로 나가는 사고를
   막는다.

## Considered Options

- **Docker Hub에 이미지 배포**: 별도 계정·시크릿 관리가 필요해 GHCR보다 설정
  비용이 크고, 저장소가 이미 GitHub에 있어 GHCR과의 자연스러운 연동(패키지
  페이지에서 소스 저장소로 역링크) 이점이 없다.
- **`package.json` 버전과 태그 일치를 검증**: 동기화 규칙을 사실상 지금
  확정하는 셈이라 API-03을 앞당겨 먹는다. 보류.

## Consequences

- CHANGELOG에 태그와 일치하는 섹션이 없으면 워크플로가 하드 실패한다(빈 노트로
  릴리즈를 만들지 않음) — `[Unreleased]`를 `[X.Y.Z] - 날짜`로 바꾸는 걸 잊으면
  태그를 다시 push해야 한다.
- GHCR 패키지는 처음 push되면 저장소가 public이어도 **패키지 자체는 기본
  private로 생성**된다 — 저장소 소유자가 패키지 설정에서 "Inherit access from
  source repository" 또는 수동 public 전환을 해야 실제로 공개된다. 이건 코드로
  해결 불가능한 GitHub 저장소 설정이라 최초 릴리즈 이후 확인이 필요한 action
  item으로 남는다.
- `API-03`이 버저닝 정책을 확정하면(예: `package.json` 버전을 태그와 동기화하는
  규칙이 생기면) 이 결정을 재검토해야 한다.
