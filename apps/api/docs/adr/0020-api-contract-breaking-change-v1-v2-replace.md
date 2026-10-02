# API 계약의 breaking change는 `/api/v1` → `/api/v2` 전체 교체로 표현하고, 병행 노출은 하지 않는다

`API-03`은 API 경로 버전과 breaking-change 정책을 확정한다.
채택 당시 `namespace.controller.ts`와 `fs.controller.ts`는 `@Controller('api/v1/...')`를 사용했다.
prefix의 의미와 breaking change 대응은 문서화되지 않은 상태였다.

## 계약 버전과 변경 기준

API 경로 prefix가 유일한 계약 버전 식별자다.
채택 당시 prefix는 `/api/v1/`이다.

breaking change는 컨트롤러 전체를 `api/v2/...`로 교체한다.
대상 변경:

- 엔드포인트·경로 제거 또는 변경
- 요청 필수 필드 추가
- 응답 필드 제거·개명·타입 변경
- 에러 응답 포맷 변경
- 인증 방식 변경
- HTTP 메소드 변경
- 상태 코드 의미 변경

하위호환 변경은 같은 prefix 안에서 반영한다.

- 옵셔널 필드 추가
- 신규 엔드포인트 추가

## 병행 노출과 배포

- `v1`과 `v2`를 동시에 노출하지 않는다.
- 구버전 라우트는 새 버전으로 교체하는 커밋에서 삭제한다.
- deprecation 유예기간은 두지 않는다.

결정 근거:

- Storix는 고객별 단일 인스턴스로 배포한다(`docs/ROADMAP.md`).
- 고객이 직접 업그레이드를 실행한다.
- 업그레이드는 인스턴스를 교체하는 방식이다(`docs/deployment/upgrade.md`).
- 한 인스턴스는 한 시점에 API 버전 하나만 제공한다.
- 무중단 마이그레이션과 멀티인스턴스 동시 지원은 업그레이드 범위 밖이다.

## release 버전과 OpenAPI

- `openapi.yaml`의 `info.version`은 release 태그(`vX.Y.Z`)를 미러링하는 참고 문자열이다.
- release 버전은 ADR-0007을 따른다.
- API 경로 버전과 release 버전은 독립된 숫자 계열이다.
- `info.version` 증가만으로 API 계약 변경 여부를 판단할 수 없다.
- release 버전은 계약 변경 없이도 증가할 수 있다.
- `docs/deployment/release.md` 절차에서 `CHANGELOG.md`와 함께 수기로 갱신한다.

## 채택 당시 초안 상태

- 버저닝 정책은 확정한다.
- 스펙 콘텐츠의 필드 형태는 draft로 유지한다.
- 채택 당시 demo 앱은 fs API 실사용 검증을 마치지 않았다.
- 해당 앱의 소스는 당시 Vite 스캐폴드 상태였다.
- 실사용 검증 후 “초안 상태” 문구와 `info.version`의 `-draft`를 제거한다.
- 1.0 확정도 이 검증 이후로 미룬다.

0.x의 MINOR bump는 breaking change를 포함할 수 있다(ADR-0007).
초안 검증을 기다리는 순서는 이 SemVer 정책과 충돌하지 않는다.
후속 1.0 확정은 api ADR-0030에 기록한다.

## Considered Options

- **API 계약 버전과 release 태그 통일**
  - `info.version`, 경로 prefix 숫자, release 태그를 같은 버전으로 관리하는 안이다.
  - admin/demo 변경이나 버그 수정도 API 계약 변경처럼 보일 수 있다.
  - 태그만으로 계약 변경 여부를 구분할 수 없어 보류했다.
- **`v1`/`v2` 병행 노출**
  - 구버전 클라이언트에 유예기간을 제공할 수 있다.
  - Storix는 SaaS 멀티테넌트가 아닌 고객별 단일 인스턴스 배포다.
  - 호출 서버도 대체로 함께 갱신한다고 가정했다.
  - 병행 호스팅의 실익이 낮다고 판단해 보류했다.
- **prefix 제거와 release 태그만 사용**
  - 기존 `/api/v1/` 경로를 제거하는 비용이 발생한다.
  - 태그와 계약 버전을 구분할 수 없는 문제도 남는다.
  - 이점이 없어 보류했다.

## Consequences

breaking change 반영은 같은 커밋에서 처리한다.

1. `namespace.controller.ts`와 `fs.controller.ts`의 `@Controller` prefix를 교체한다.
2. `openapi.yaml`의 `paths`를 같은 prefix로 갱신한다.

라우트와 스펙의 불일치는 `route-coverage.spec.ts`가 검사한다(api ADR-0019).

1.0 확정은 새 ADR 또는 `CHANGELOG.md` 항목으로 기록한다.
이 ADR의 당시 결정을 새 상태로 덮어쓰지 않는다.
