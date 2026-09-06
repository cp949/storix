# 0001. 저장소 구조를 모노레포로 전환

## 상태

승인됨 (2026-09-06)

## 배경

기존 저장소는 Storix API 서버 단일 프로젝트로 구성되어 있었다. 로드맵상
관리자용 보안/로그 관제 화면(`admin`), API 연동 레퍼런스 예제(`demo`), 향후
CLI/SDK(`packages/`)를 같은 저장소에서 관리해야 하는데, 단일 프로젝트
구조에는 이들을 넣을 자리가 없었다.

## 결정

Turborepo + pnpm workspace로 전환한다.

- `apps/api`(`@storix/api`): 기존 NestJS 서버. 코드는 순수 이동만 진행했다
  (내부 import가 전부 상대 경로라 소스 변경 없이 이동 가능했다).
- `apps/admin`, `apps/demo`: Vite 8 + React 19 스캐폴딩만 우선 배치. 화면/기능은
  이후 별도 단계에서 구현한다.
- `packages/`: CLI/SDK를 위해 예약. 이름은 아직 미정이다.
- 패키지 매니저는 npm에서 pnpm으로 전환했다. pnpm의 엄격한 workspace 격리가
  `demo`가 `api`의 내부 의존성을 실수로 끌어다 쓰는 것을 막아준다. 이 격리는
  전환 과정에서 실제로 효과를 보였다 — `apps/api`가 `@types/express-serve-static-core`를
  명시적으로 선언하지 않고 `@types/express`의 전이 의존성에 얹혀가던 phantom
  dependency를 pnpm 클린 설치가 즉시 드러냈다.
- `docs/agents/domain.md`가 정의한 multi-context 저장소 패턴을 그대로
  적용한다: 루트 `docs/adr/`는 이 문서처럼 시스템 전역 결정을, 각 컨텍스트의
  `docs/adr/`(예: `apps/api/docs/adr/`)는 해당 컨텍스트 결정을 담는다.
- `api`의 기존 Jest 테스트는 vitest로 마이그레이션하지 않는다. 이미 통과 중인
  테스트를 다시 검증하는 비용 대비 러너 통일의 실익이 낮다고 판단했다.
  `admin`/`demo`는 신규 Vite 앱이므로 vitest 5.x를 쓴다.

## 결과

- 루트 `package.json`은 workspace root로, 실행 스크립트는 `turbo run <task>`로
  위임한다.
- `apps/api`를 빌드하는 `Dockerfile`은 `turbo prune --docker` 패턴으로
  재작성했다 — pnpm workspace에서 특정 패키지만 컨테이너 이미지로 빌드할 때
  공식적으로 권장되는 방식이다.
- TypeScript를 6.0.3으로 올리며 `tsconfig.json`의 `baseUrl`(미사용, deprecated)을
  제거하고 `rootDir`을 명시했다. 또한 TypeScript 6.0에서 `@types/jest` 자동
  포함이 되지 않아 `types: ["jest", "node"]`를 명시적으로 지정했다.
- 전체 로드맵과 실행 순서는 `docs/ROADMAP.md`를 따른다.
