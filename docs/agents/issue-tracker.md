# Issue tracker: GitHub

Issues for this repo live as GitHub issues. Use the `gh` CLI for all operations.

Design specs and implementation plans are not issues. One-off task documents live in `_works/` (untracked), long-lived designs in `docs/design/`. See `docs/agents/rubber-workflow.md`. Do not register them with `gh issue create`.

## 등록 기준

issue는 미해결 항목을 추적하는 수단이다. 작업 이력은 커밋 메시지, `CHANGELOG.md`, `docs/`가 남긴다.
issue로 남길 가치가 있는 것만 등록한다.

등록한다:

- 지금 구현하지 않고 보류하는 항목
- 사용자나 다른 에이전트가 따로 추적해야 하는 항목
- 외부 보고, 또는 재현 조건·원시 로그를 보존해야 하는 간헐 실패
- 영향이 커서 별도 논의·승인 기록이 필요한 결함 (높음·중간 심각도)

등록하지 않는다:

- 같은 세션에서 구현해 dev에 병합할 낮은 심각도 결함. issue를 열자마자 닫게 되어 추적 기능이 없다.
- 사소해서 버려도 되는 후속 작업
- 설계·구현 계획 (위 규칙)

등록하지 않은 수정의 결정 근거와 검증 범위는 커밋 본문에 요약한다. 수정 내용은 `CHANGELOG.md`에 적는다.

## 작업 완료와 자동 종료

관련 GitHub issue가 있는 작업은 아래 조건을 모두 충족하면 별도 요청·확인 없이 해당 issue를 종료한다.
rubber-workflow 사용 여부와 무관하게 적용한다.

- issue 본문·댓글의 수용 조건과 작업의 필수 완료 조건을 모두 충족했다.
- 필요한 검증을 완료했다. 허용 편차와 제외 항목은 합의된 완료 기준을 따른다.
- 코드·문서 변경이 있으면 최종 커밋이 로컬 `dev`에 반영돼 있다.
- 조사·결정 작업이면 issue가 요구한 결과와 결정 기록이 남아 있다.

종료 절차:

1. `gh issue view <번호> --comments`로 최신 요구와 상태를 확인한다. 이미 닫힌 issue는 다시 종료하지 않는다.
2. 완료 댓글에 구현·조사 결과, 최종 커밋, 검증 범위·통과/실패 수·재실행, 미실행 항목·남은 한계를 적는다.
   이전 검증 기록을 인용하면 이번 종료 작업에서 재실행한 결과와 구분한다.
3. 댓글 본문을 임시 파일에 쓰고 `gh issue comment <번호> --body-file <파일>`로 게시한다.
4. `gh issue close <번호> --reason completed`로 종료한다.
5. `gh issue view <번호> --json state,stateReason,url`로 `CLOSED`·`COMPLETED`를 확인하고 사용자에게 링크를 보고한다.

- 로컬 `dev` 반영만으로 수용 조건을 충족하면 push 전에도 종료한다. 종료를 위해 push·릴리스를 수행하지 않는다.
- issue가 push·릴리스·배포·외부 검증을 수용 조건으로 요구하면 해당 조건이 충족될 때까지 열어 둔다.
- 일부 항목만 완료했거나 필수 검증이 실패·미실행이면 종료하지 않는다. 미충족 조건을 보고한다.
- 미완료 항목을 후속 issue로 옮겨 원래 수용 조건을 축소하는 판단은 자동으로 하지 않는다.
- 이번 작업과 무관한 issue는 종료하지 않는다.
- 댓글 게시·종료·상태 확인에 실패하면 완료한 작업과 실패한 GitHub 처리를 구분해 보고한다.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
