# Triage 라벨

스킬은 다섯 가지 표준 triage 역할을 사용한다. 이 문서는 각 역할을 이 저장소의 이슈 추적기에서 사용하는 실제 라벨 문자열에 매핑한다.

| mattpocock/skills의 라벨 | 이 저장소의 라벨 | 의미 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 관리자가 이슈를 검토해야 함 |
| `needs-info` | `needs-info` | 제보자의 추가 정보를 기다리는 중 |
| `ready-for-agent` | `ready-for-agent` | 명세가 완료되어 AFK 에이전트가 처리할 수 있음 |
| `ready-for-human` | `ready-for-human` | 사람의 구현이 필요함 |
| `wontfix` | `wontfix` | 처리하지 않기로 결정함 |

스킬이 역할을 언급하면(예: "AFK 처리 가능 triage 라벨을 적용") 이 표에서 대응하는 라벨 문자열을 사용한다.

## 등록 상태

다섯 라벨 모두 `cp949/storix`에 실제로 존재한다(2026-09-06 `gh label list` 확인, 4개는 이 세션에서 신규 생성). 스킬이 라벨을 적용하기 전에 따로 만들 필요가 없다.

| 라벨 | 색 | 출처 |
| --- | --- | --- |
| `needs-triage` | `#fbca04` | 2026-09-06 등록 |
| `needs-info` | `#d4c5f9` | 2026-09-06 등록 |
| `ready-for-agent` | `#0e8a16` | 2026-09-06 등록 |
| `ready-for-human` | `#1d76db` | 2026-09-06 등록 |
| `wontfix` | `#ffffff` | 저장소 생성 시 GitHub 기본 라벨 |

`wontfix`만 설명이 영문(`This will not be worked on`)이다 — GitHub이 만든 기본 라벨이고 의미가 위 표와 같아 바꾸지 않았다.

라벨이 지워졌거나 같은 세트를 다른 저장소에 만들 때:

```bash
gh label create needs-triage    -c fbca04 -d "관리자가 이슈를 검토해야 함"
gh label create needs-info      -c d4c5f9 -d "제보자의 추가 정보를 기다리는 중"
gh label create ready-for-agent -c 0e8a16 -d "명세가 완료되어 AFK 에이전트가 처리할 수 있음"
gh label create ready-for-human -c 1d76db -d "사람의 구현이 필요함"
```

현재 상태는 `gh label list`로 확인한다.

실제 사용하는 라벨 명칭이나 색이 달라지면 위 두 표를 함께 수정한다.
