# 0001. 저장소 구조를 모노레포로 전환

## 상태

승인됨 (2026-09-06)

## 배경

기존 저장소는 Storix API 서버 단일 프로젝트였다. 로드맵은 다음 구성 요소를 같은 저장소에서 관리하도록 요구한다.

- `admin`: 관리자용 보안·로그 관제 화면.
- `demo`: API 연동 레퍼런스 예제.
- `packages/`: 향후 CLI/SDK.

단일 프로젝트 구조에는 이들을 배치할 자리가 없었다.

## 결정

Turborepo + pnpm workspace로 전환한다.

- `apps/api`(`@cp949/storix-api`)에 기존 NestJS 서버를 이동한다.
  - 내부 import가 모두 상대 경로여서 소스 변경 없이 이동했다.
- `apps/admin`, `apps/demo`에 Vite 8 + React 19 스캐폴딩을 배치한다.
  - 화면·기능은 별도 단계에서 구현한다.
- `packages/`는 CLI/SDK용으로 예약한다.
  - 패키지 이름은 미정이다.
- 패키지 매니저를 npm에서 pnpm으로 전환한다.
  - workspace 격리로 `demo`가 `api`의 내부 의존성을 사용하는 실수를 막는다.
  - 전환 시 클린 설치가 `apps/api`의 phantom dependency를 드러냈다.
  - `apps/api`는 `@types/express-serve-static-core`를 직접 선언하지 않고 `@types/express`의 전이 의존성에 의존하고 있었다.
- `docs/agents/domain.md`의 multi-context 패턴을 적용한다.
  - 루트 `docs/adr/`는 시스템 전역 결정을 담는다.
  - 각 컨텍스트의 `docs/adr/`는 해당 컨텍스트의 결정을 담는다. 예: `apps/api/docs/adr/`.
- `api`의 기존 Jest 테스트를 유지한다.
  - 러너 통일의 실익이 이미 통과하는 테스트를 다시 검증하는 비용보다 낮다고 판단했다.
- 신규 Vite 앱인 `admin`/`demo`는 vitest 5.x를 쓴다.

## 결과

- 루트 `package.json`은 workspace root가 된다.
- 루트 실행 스크립트는 `turbo run <task>`에 위임한다.
- `apps/api`의 `Dockerfile`은 `turbo prune --docker` 패턴을 쓴다.
  - 당시 pnpm workspace의 특정 패키지 이미지 빌드에 공식 권장된 방식이다.
- TypeScript를 6.0.3으로 올렸다.
  - 사용하지 않던 deprecated 옵션 `baseUrl`을 `tsconfig.json`에서 제거했다.
  - `rootDir`을 명시했다.
  - TypeScript 6.0에서 `@types/jest`가 자동 포함되지 않아 `types: ["jest", "node"]`를 명시했다.
- 전체 로드맵과 실행 순서는 `docs/ROADMAP.md`를 따른다.
