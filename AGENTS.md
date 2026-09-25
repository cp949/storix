## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo. Use the `gh` CLI for all operations. Design specs and implementation plans are not issues (see `docs/agents/rubber-workflow.md`). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, label strings equal to their names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), all registered on `cp949/storix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context (`CONTEXT-MAP.md` at the repo root). See `docs/agents/domain.md`.
System-wide decisions: `docs/adr/` at the repo root. api context: `apps/api/CONTEXT.md`, `apps/api/docs/adr/`.

### Roadmap

Long-term goals and requirements for production maturity: `docs/ROADMAP.md`.

### Local verification

Podman-first local workflow, compose validation via `podman-compose config`, known WSL/podman defects and their workarounds: `docs/agents/local-verification.md`.

### Changelog

User-facing changes go in `CHANGELOG.md` (Keep a Changelog format) under `## [Unreleased]`, in the fitting category (Added/Changed/Deprecated/Removed/Fixed/Security). Not CI-enforced — add the entry as part of the same change, don't defer it.

### 작업 실행 (rubber-workflow)

브레인스토밍으로 확정한 작업이나 `docs/ROADMAP.md` 항목 하나처럼 한 번에 끝내기 큰 작업은 rubber-workflow(DELTA 단위, 탄력적 추가, `dev` 브랜치 + 재그룹화 병합)를 따른다. See `docs/agents/rubber-workflow.md`.

### 문서 배치

- 일회성 작업 문서(설계 초안, 구현 계획, checklist, DELTA)는 `_works/<yyyyMMdd>-NN-<제목>/`에 둔다. git 추적 대상이 아니다.
- 스킬이 `docs/superpowers/` 등 `docs/` 하위에 설계·계획을 쓰라고 안내해도 따르지 않고 `_works/`에 쓴다. `docs/` 아래에 스킬 이름 디렉터리를 만들지 않는다.
- 장기 유지할 설계는 `docs/design/`(ADR보다 상세한 현재 시점 설계. 줄 번호 금지, 이력 없이 현재 내용으로 갱신), 결정과 대안은 `docs/adr/`, 작업 중 발견한 함정은 `docs/traps/`에 둔다. 설계를 바꾸는 변경은 같은 브랜치에서 해당 설계 문서도 갱신한다. 승격 기준은 `docs/agents/rubber-workflow.md`.
- 설계 문서·구현 계획을 GitHub issue로 등록하지 않는다.
