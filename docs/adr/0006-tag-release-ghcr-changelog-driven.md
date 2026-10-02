# 태그 릴리즈는 `package.json` 버전과 무관하게 git tag + CHANGELOG만으로 동작한다

API-02(태그 push 트리거 릴리즈)의 결정은 다음과 같다.

1. **릴리즈 버전의 원천은 git tag(`vX.Y.Z`)와 `CHANGELOG.md`의 `## [X.Y.Z]` 섹션이다.**
   - `package.json` 4개(root/api/admin/demo)의 `version` 필드는 읽거나 검증하거나 갱신하지 않는다.
   - 필드 동기화 정책은 `API-03`(1.0 직전 버저닝/breaking-change 정책)으로 미룬다(`DEPLOY-04`).
   - 릴리즈 워크플로에서 먼저 확정하면 API-03의 선택지가 줄어든다.
2. **이미지는 GHCR(`ghcr.io/cp949/storix`)에 배포한다.**
   - public 저장소의 공개 패키지는 별도 비용이 들지 않는다.
   - 내장 `GITHUB_TOKEN`으로 인증하므로 별도 시크릿이 필요 없다.
3. **태그가 가리키는 커밋이 `origin/main`의 조상이 아니면 릴리즈를 중단한다.**
   - `dev`나 작업 브랜치에 잘못 붙인 태그가 공개 이미지·릴리즈로 배포되는 것을 막는다.

## Considered Options

- **Docker Hub에 이미지 배포**: 채택하지 않는다.
  - 별도 계정·시크릿 관리가 필요하다.
  - GHCR보다 설정 비용이 크다.
  - GHCR은 패키지 페이지에서 GitHub 소스 저장소로 연결한다.
- **`package.json` 버전과 태그 일치 검증**: 보류한다.
  - API-03의 동기화 정책을 앞서 확정하게 된다.

## Consequences

- CHANGELOG에 태그와 일치하는 섹션이 없으면 워크플로가 실패한다.
  - 빈 노트로 릴리즈를 만들지 않는다.
  - 태그 push 전에 `[Unreleased]`를 `[X.Y.Z] - 날짜`로 바꿔야 한다.
  - 누락하면 태그를 다시 push해야 한다.
- GHCR 패키지는 처음 push할 때 기본 private로 생성된다.
  - 소스 저장소가 public이어도 별도 공개 설정이 필요하다.
  - 소유자가 "Inherit access from source repository" 설정 또는 수동 public 전환을 확인해야 한다.
  - 최초 릴리즈 이후 확인할 GitHub 설정 작업으로 남긴다.
- `API-03`이 버저닝 정책을 확정하면 이 결정을 재검토한다.
  - 예: `package.json` 버전을 태그와 동기화하는 규칙 채택.
