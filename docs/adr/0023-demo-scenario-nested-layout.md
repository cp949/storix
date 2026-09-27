# 데모 시나리오는 apps/demoN/{web,was} 계층 구조로 배치한다

## 상태

승인됨 (2026-09-10) — demo1 이동 구현 완료. demo2는 미착수.

## 배경

`apps/demo`(`@storix/demo`, 프론트엔드)와 `apps/demo-was`(`@storix/demo-was`,
백엔드 소비자)가 `apps/` 루트에 `api`/`admin`과 나란히 평면으로 배치돼
있었다. 두 가지 문제가 있었다:

1. `demo`라는 이름만으로는 웹인지 서버인지 알 수 없었다(`demo-was`는 이름으로
   역할이 드러나는 것과 대조적).
2. `demo`와 `demo-was`가 한 쌍이라는 사실이 폴더 구조로 드러나지 않았다 —
   `apps/` 목록만 봐서는 관련 항목인지 알 수 없었다.

여기에 더해 데모 시나리오를 하나 더 추가할 계획이 확정됐다: `demo1`(현재
`demo`/`demo-was`, 보안 최소화 버전)과 별도로 `demo2`(mTLS 등 풀보안 버전,
실무에 가까운 복잡한 케이스를 추가하며 Storix 자체의 개선점을 검증하는
용도)를 만든다. 시나리오가 하나뿐이었다면 `apps/demo-web`/`apps/demo-was`
같은 평면 접두어로도 짝은 표현할 수 있었지만, 시나리오가 복수로 늘어나는
것이 확정된 이상 `apps/` 루트가 데모 계열 항목으로 계속 늘어나며 `api`/
`admin` 같은 핵심 앱과 섞여 보이는 문제가 커진다.

## 결정

1. **`apps/demo` → `apps/demo1/web`, `apps/demo-was` → `apps/demo1/was`로
   이동한다.** 패키지명도 `@storix/demo` → `@storix/demo1-web`,
   `@storix/demo-was` → `@storix/demo1-was`로 바꾼다. `ls apps/demo1`만으로
   해당 데모 시나리오의 구성(web+was)이 보이는 것이 목적이다.
2. **`pnpm-workspace.yaml`의 `packages`에 `apps/*/*`를 추가한다.**
   `demo1`/`demo2`는 자체 `package.json`이 없는 컨테이너 디렉터리이므로
   `apps/*`만으로는 하위 `web`/`was`가 workspace 패키지로 잡히지 않는다.
3. **`demo2`는 지금 폴더를 만들지 않는다.** 실제 구현에 착수할 때
   `apps/demo2/{web,was}`(패키지명 `@storix/demo2-web`/`@storix/demo2-was`)로
   이 ADR과 동일한 구조를 따른다. 빈 컨테이너 폴더를 미리 git에 남겨둘
   이유가 없다.
4. **소스 내부 식별자는 이동과 함께 바꾸지 않는다.** `DEMO_WAS_*` 환경변수
   접두어, `DemoWasConfig`/`DEMO_WAS_CONFIG` 등은 폴더 위치와 무관한 논리적
   이름이라 그대로 둔다.
5. **`docs/deployment/scenarios/demo-all-in-one/` 아래 compose 서비스명
   (`demo-was`)과 시나리오 디렉터리명은 이번 변경 범위 밖이다.** 이 시나리오
   자체를 `demo1` 전용으로 재편할지는 `demo2` 시나리오가 실제로 생길 때
   함께 판단한다.

## Considered Options

- **`apps/demo-web`, `apps/demo-was` 평면 접두어 유지**: 이름만으로 짝은
  알 수 있지만, `demo2` 계열까지 추가되면 `apps/` 루트가 데모 항목 4개
  (`demo1-web`/`demo1-was`/`demo2-web`/`demo2-was`)로 늘어나 핵심 앱과 섞여
  보인다. `demo2` 확정 이후에는 계층 구조가 구조적으로 더 명확하다고 판단해
  보류.
- **`apps/` 밖으로 이동(`demo1/`, `demo2/`를 저장소 최상위에 배치)**:
  ADR-0001이 정한 `apps/`(api/admin/demo) 관례와 어긋나고, `apps/` 안에서
  중첩하는 것만으로 목적(짝 노출)을 이미 달성하므로 보류.
- **`demo2` 폴더를 지금 미리 스캐폴딩**: 아직 내용이 없는 빈 디렉터리는
  git이 추적하지 못하고, 실제 구현 시작 시점에 만들어도 충분해 보류.

## Consequences

- 대상 지정은 `pnpm --filter @storix/demo1-web`, `pnpm --filter
@storix/demo1-was`로 한다.
- `apps/demo1/was/Dockerfile`, `docs/deployment/scenarios/demo-all-in-one/
nginx/Dockerfile`, `compose.demo.yml`,
  `.github/workflows/demo-all-in-one-smoke.yml`의 경로/패키지명 참조를
  전부 갱신했다.
- 과거 ADR(0001, 0002, 0007, 0012, 0020)과 `CHANGELOG.md`의 `apps/demo`/
  `apps/demo-was` 언급은 작성 시점 기록이므로 소급 수정하지 않는다.
- `docs/ROADMAP.md`의 구조 다이어그램을 새 레이아웃으로 갱신했다.
- `demo2` 착수 시 이 ADR의 구조(`apps/demo2/{web,was}`, 패키지명
  `@storix/demo2-web`/`@storix/demo2-was`)를 그대로 따른다.
