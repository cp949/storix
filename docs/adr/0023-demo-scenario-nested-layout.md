# 데모 시나리오는 apps/demoN/{web,was} 계층 구조로 배치한다

## 상태

승인됨 (2026-09-10)

- demo1 이동 구현 완료.
- 결정 시점에 demo2는 미착수.

## 배경

기존 데모는 `apps/` 루트에 `api`/`admin`과 나란히 배치돼 있었다.

- `apps/demo`(`@cp949/storix-demo`): 프론트엔드.
- `apps/demo-was`(`@cp949/storix-demo-was`): 백엔드 소비자.

이 배치에는 다음 문제가 있었다.

- `demo`라는 이름에서 웹·서버 역할을 구분하기 어렵다.
- 폴더 구조에서 `demo`와 `demo-was`가 한 쌍임을 알기 어렵다.

추가 데모 시나리오도 확정했다.

- `demo1`: 기존 `demo`/`demo-was`의 보안 최소화 버전.
- `demo2`: mTLS 등을 적용한 전체 보안 버전.
  - 실무에 가까운 복잡한 사례로 Storix의 개선점을 검증한다.

평면 접두어로도 시나리오의 짝은 표현할 수 있다.
다만 시나리오가 늘면 `apps/` 루트에서 데모 항목과 핵심 앱이 섞인다.

## 결정

1. **데모를 시나리오별 하위 디렉터리로 이동한다.**
   - `apps/demo` → `apps/demo1/web`.
   - `apps/demo-was` → `apps/demo1/was`.
   - `@cp949/storix-demo` → `@cp949/storix-demo1-web`.
   - `@cp949/storix-demo-was` → `@cp949/storix-demo1-was`.
   - `ls apps/demo1`만으로 web+was 구성을 알 수 있게 한다.
2. **`pnpm-workspace.yaml`의 `packages`에 `apps/*/*`를 추가한다.**
   - `demo1`/`demo2`는 자체 `package.json`이 없는 묶음 디렉터리다.
   - `apps/*`만으로는 하위 `web`/`was`를 workspace 패키지로 찾지 못한다.
3. **`demo2` 폴더는 구현 착수 시 만든다.**
   - 경로는 `apps/demo2/{web,was}`다.
   - 패키지명은 `@cp949/storix-demo2-web`/`@cp949/storix-demo2-was`다.
   - 내용 없는 폴더는 미리 만들지 않는다.
4. **소스 내부 식별자는 유지한다.**
   - 대상은 `DEMO_WAS_*`, `DemoWasConfig`, `DEMO_WAS_CONFIG` 등이다.
   - 폴더 위치와 무관한 논리적 이름이다.
5. **배포 시나리오 이름은 변경 범위에서 제외한다.**
   - 대상은 `docs/deployment/scenarios/demo-all-in-one/`과 compose 서비스명 `demo-was`다.
   - demo1 전용 재편 여부는 demo2 배포 시나리오가 생길 때 판단한다.

## Considered Options

- **`apps/demo-web`, `apps/demo-was` 평면 접두어 유지**: 보류한다.
  - 이름에서 짝을 구분할 수 있다.
  - demo2까지 추가하면 루트에 `demo1-web`/`demo1-was`/`demo2-web`/`demo2-was`가 나열된다.
  - 핵심 앱과의 구분은 계층 구조가 더 명확하다고 판단했다.
- **`demo1/`, `demo2/`를 저장소 최상위에 배치**: 보류한다.
  - ADR-0001의 `apps/` 배치 관례와 어긋난다.
  - `apps/` 안의 중첩만으로 짝을 드러낼 수 있다.
- **demo2 미리 스캐폴딩**: 보류한다.
  - git은 빈 디렉터리를 추적하지 않는다.
  - 구현 착수 시 만들어도 된다.

## Consequences

- 패키지 선택은 다음 filter를 사용한다.
  - `pnpm --filter @cp949/storix-demo1-web`.
  - `pnpm --filter @cp949/storix-demo1-was`.
- 다음 파일의 경로·패키지명 참조를 갱신했다.
  - `apps/demo1/was/Dockerfile`.
  - `docs/deployment/scenarios/demo-all-in-one/nginx/Dockerfile`.
  - `compose.demo.yml`.
  - `.github/workflows/demo-all-in-one-smoke.yml`.
- 과거 ADR과 `CHANGELOG.md`의 `apps/demo`/`apps/demo-was`는 당시 기록으로 유지한다.
  - 대상은 ADR-0001, ADR-0002, ADR-0007, api ADR-0012, api ADR-0020이다.
- `docs/ROADMAP.md`의 구조 다이어그램을 갱신했다.
- demo2 착수 시 결정한 `apps/demo2/{web,was}` 구조와 패키지명을 따른다.
