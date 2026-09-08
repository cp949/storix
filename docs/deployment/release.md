# 릴리즈 절차

`API-02`. 새 버전을 태그로 릴리즈하는 절차다. 설계 배경은
`../adr/0006-tag-release-ghcr-changelog-driven.md` 참고. 이 문서는 릴리즈를
**만드는** 쪽 절차다 — 이미 나온 버전으로 배포 인스턴스를 올리는 절차는
`upgrade.md`.

태그를 push하는 것 자체가 릴리즈를 트리거한다. 이 저장소는 지시 없이는
릴리즈하지 않는다 — 아래 절차는 전부 사람이 직접 실행한다.

## 절차

1. **`CHANGELOG.md`를 버전 섹션으로 정리한다**(`main`에 병합되기 전, `dev`나
   작업 브랜치에서). `[Unreleased]`를 `[X.Y.Z] - YYYY-MM-DD`로 바꾸고, 그 위에
   새 빈 `[Unreleased]`를 추가한다.

   ```md
   ## [Unreleased]

   ## [1.2.3] - 2026-09-08

   ### Added

   - ...
   ```

   `.github/scripts/extract-changelog-section.mjs`가 이 헤딩(`## [1.2.3]`)을
   찾아 릴리즈 노트로 쓴다 — 헤딩이 없으면 릴리즈 워크플로가 실패한다.

2. **`main`에 병합한다**(기존 정책대로 직접 수행).

3. **태그를 만들어 push한다.**

   ```bash
   git tag v1.2.3   # CHANGELOG 섹션과 반드시 같은 버전 문자열
   git push origin v1.2.3
   ```

4. **GitHub Actions(`release.yml`)가 자동으로 실행한다**:
   - 태그 커밋이 `origin/main`의 조상인지 확인(아니면 중단)
   - `apps/api` typecheck·lint·단위 테스트(실패하면 중단, 통합 테스트는 제외)
   - `CHANGELOG.md`에서 `## [1.2.3]` 섹션 추출(없으면 중단)
   - `ghcr.io/cp949/storix:v1.2.3` + `:latest` 이미지 build & push
   - GitHub Release 생성(제목 `v1.2.3`, 본문은 추출한 CHANGELOG 섹션 + 이미지
     pull 안내)

   진행 상황은 저장소 Actions 탭에서 확인한다.

## 실패 시 대응

워크플로가 어느 단계에서 실패하든 GHCR push·GitHub Release 생성 둘 다
일어나지 않는다(순서상 검증·추출이 먼저다) — 부분적으로 나간 릴리즈는 없다.

- **게이트(typecheck/lint/test) 실패**: 코드를 고쳐 `main`에 다시 병합한 뒤,
  같은 버전을 재시도하려면 아래 "태그 재사용"을 따른다.
- **CHANGELOG 섹션 없음**: 1번을 빠뜨린 경우다. `CHANGELOG.md`를 고쳐
  `main`에 병합한 뒤 태그를 재사용한다.
- **main 조상 아님**: 태그를 잘못된 브랜치의 커밋에 달았다는 뜻이다. `main`의
  올바른 커밋에 다시 태그한다.

### 태그 재사용

이미 push한 태그를 삭제하고 같은 이름으로 다시 달아야 할 때만 필요하다.
같은 버전 번호를 재사용하지 않고 다음 patch 버전(`v1.2.4`)으로 다시 시도하는
쪽이 더 간단하고 안전하다 — 태그 재사용은 이미 그 태그를 pull한 사람이 있을
가능성이 생긴 뒤엔(예: 실패한 릴리즈라도 이미지가 일부 push됐던 경우) 특히
피한다.

```bash
git push origin :refs/tags/v1.2.3   # 원격 태그 삭제
git tag -d v1.2.3                   # 로컬 태그 삭제
git tag v1.2.3 && git push origin v1.2.3   # 재생성
```

```txt
위험도: 낮음(태그만 대상, 커밋 히스토리·브랜치는 건드리지 않음)
롤백: 태그를 다시 삭제하면 됨. 단, GHCR에 이미 push된 이미지나 생성된 GitHub
Release는 이 명령으로 되돌아가지 않는다 — 필요하면 GHCR 패키지/Release를
수동으로 삭제해야 한다.
```

## 알려진 제약

- **GHCR 패키지 공개 설정**: 저장소는 public이지만 GHCR 패키지는 최초 push
  시 기본 private로 생성된다. 첫 릴리즈 이후 저장소 Packages 설정에서 공개
  전환이 됐는지 확인이 필요하다(ADR-0006 Consequences).
- **`package.json` 버전과는 무관**: `root`/`api`/`admin`/`demo` 4개
  `package.json`의 `version` 필드는 이 절차가 건드리지 않는다. 동기화 정책은
  `API-03`.
- **사전 빌드 이미지로 업그레이드**는 아직 안 됨 — `docker-compose.yml`에
  `image:` 필드가 없어 `docker compose pull`로 받을 수 없다(`upgrade.md` 참고,
  후속 과제).
