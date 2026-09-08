## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in this repo. Use the `gh` CLI for all operations. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, label strings equal to their names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), all registered on `cp949/storix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context (`CONTEXT-MAP.md` at the repo root). See `docs/agents/domain.md`.
System-wide decisions: `docs/adr/` at the repo root. api context: `apps/api/CONTEXT.md`, `apps/api/docs/adr/`.

### Roadmap

Long-term goals and requirements for production maturity: `docs/ROADMAP.md`.

### Local verification

Podman-first local workflow, compose validation via `podman-compose config`, known WSL/podman defects and their workarounds: `docs/agents/local-verification.md`.
