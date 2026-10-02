# 릴리즈 절차

API-02. 새 버전을 태그로 게시하는 절차다.
결정은 [ADR-0006](../adr/0006-tag-release-ghcr-changelog-driven.md)을 따른다.
배포 인스턴스의 버전 변경은 [업그레이드 절차](./upgrade.md)를 따른다.

태그 push가 릴리즈를 실행한다.
사용자 지시 없이 릴리즈하지 않는다.
아래 수동 절차는 사람이 실행한다.

## 절차

1. `dev` 또는 작업 브랜치에서 버전 정보를 갱신한다.
   - `CHANGELOG.md`의 `[Unreleased]`를 `[X.Y.Z] - YYYY-MM-DD`로 바꾼다.
   - 그 위에 빈 `[Unreleased]`를 추가한다.
   - `apps/api/openapi.yaml`의 `info.version`을 릴리즈 태그와 맞춘다.
   - `info.version`은 API 계약 변경 여부와 무관하게 갱신한다(api ADR-0020).

   ```md
   ## [Unreleased]

   ## [1.2.3] - 2026-09-08

   ### Added

   - ...
   ```

   - `.github/scripts/extract-changelog-section.mjs`는 `## [1.2.3]`을 릴리즈 노트로 추출한다.
   - 해당 헤딩이 없으면 워크플로가 실패한다.

2. `main`에 병합한다.

3. 릴리즈 대상 커밋의 계약 검증 결과를 확인한다.
   - `release.yml`은 통합 테스트와 계약 검증을 실행하지 않는다.
   - `contract.yml`의 SQLite·Postgres 결과를 확인한다.
   - SQLite는 `dev` push·PR에서 실행한다. 수동 실행에서는 실행하지 않는다.
   - 릴리즈 대상 커밋 또는 같은 트리의 `dev` 커밋 결과를 사용한다.
   - Postgres 16·17 matrix는 수동 실행과 주 1회 스케줄에서 실행한다.
   - 아래 명령으로 `main` 검증을 요청하고 완료 결과를 확인한다.

   ```bash
   gh workflow run contract.yml --ref main
   gh run list --workflow contract.yml --limit 3
   ```

   - SQLite와 Postgres matrix가 모두 성공해야 태그를 만든다.
   - 실패하면 구현을 수정한 뒤 검증부터 다시 진행한다.
   - run URL과 대상 커밋 해시는 릴리즈 노트에 자동 기록되지 않는다.
   - 필요하면 GitHub Release 생성 후 노트에 추가한다.

4. 태그를 만들고 push한다.

   ```bash
   git tag v1.2.3   # CHANGELOG 섹션과 반드시 같은 버전 문자열
   git push origin v1.2.3
   ```

5. GitHub Actions의 `release.yml` 결과를 확인한다.
   - 저장소 Actions 탭에서 진행 상황을 확인한다.
   - 워크플로는 다음 순서로 실행한다.
     1. 태그 커밋이 `origin/main`의 조상인지 검사한다.
     2. CHANGELOG 추출 스크립트의 단위 테스트를 실행한다.
     3. `apps/api` typecheck·lint·단위 테스트를 실행한다.
     4. `CHANGELOG.md`에서 버전 섹션을 추출한다.
     5. Postgres 17 client 이미지 `ghcr.io/cp949/storix:v1.2.3`와 `:latest`를 build·push한다.
     6. Postgres 16 client 이미지 `ghcr.io/cp949/storix:v1.2.3-pg16`을 build·push한다.
     7. GitHub Release를 생성한다.
   - Release 제목은 `v1.2.3`이다.
   - 본문은 CHANGELOG 섹션, 이미지 pull 안내와 업그레이드·롤백 경계다.
   - 롤백 안내는 [업그레이드 절차](./upgrade.md)와 api ADR-0017을 따른다.

## 실패 시 대응

실패 지점별 게시 상태:

| 실패 지점                            | 게시 상태                             |
| ------------------------------------ | ------------------------------------- |
| main 조상 검사·테스트·CHANGELOG 추출 | 이미지 push와 Release 생성 전이다     |
| 이미지 build·push                    | 일부 이미지나 태그가 게시됐을 수 있다 |
| GitHub Release 생성                  | 이미지 push는 이미 완료됐다           |

워크플로는 이미 게시한 이미지를 자동으로 되돌리지 않는다.
실패 후에는 GHCR 태그와 GitHub Release의 실제 상태를 확인한다.

- 게이트 실패: 코드를 수정하고 `main`에 병합한다.
- CHANGELOG 섹션 누락: 버전 헤딩을 추가하고 `main`에 병합한다.
- main 조상 검사 실패: `main`의 올바른 커밋에 태그한다.
- 같은 버전을 다시 쓰려면 아래 "태그 재사용"을 따른다.

### 태그 재사용

가능하면 다음 patch 버전(`v1.2.4`)으로 다시 릴리즈한다.
이미 게시되거나 pull된 태그는 재사용을 피한다.
부분적으로 push된 이미지도 게시 상태에 포함한다.

이미 push한 태그를 삭제하고 같은 이름으로 다시 만들 때만 아래 명령을 쓴다.

```bash
git push origin :refs/tags/v1.2.3   # 원격 태그 삭제
git tag -d v1.2.3                   # 로컬 태그 삭제
git tag v1.2.3 && git push origin v1.2.3   # 재생성
```

```txt
위험도: 낮음(태그만 대상, 커밋 히스토리·브랜치는 건드리지 않음)
롤백: 태그를 다시 삭제할 수 있다. 게시된 GHCR 이미지와 GitHub Release는 되돌리지 않는다.
필요하면 GHCR 패키지와 Release를 별도로 삭제한다.
```

## 알려진 제약

- GHCR 패키지는 최초 push 시 private로 생성된다.
- 첫 릴리즈 후 Packages 설정에서 공개 여부를 확인한다(ADR-0006 Consequences).
- 이 절차는 `package.json`의 `version`을 갱신하지 않는다. 동기화 정책은 API-03이다.
- 기본 Compose는 `build:`만 정의한다.
- `image:`가 없어 `docker compose pull`로 사전 빌드 이미지를 받는 업그레이드는 제공하지 않는다.
