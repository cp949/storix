# API 계약의 breaking change는 `/api/v1` → `/api/v2` 전체 교체로 표현하고, 병행 노출은 하지 않는다

`API-03`(버저닝/breaking-change 정책)에서 나온 결정이다. `namespace.controller.ts`/
`fs.controller.ts`가 이미 `@Controller('api/v1/...')`로 `v1` prefix를 갖고
있었지만, 이게 무엇을 의미하는지, breaking change 때 어떻게 다루는지는
문서화된 적이 없었다.

- **`/api/v1/` prefix가 유일한 API 계약 버전 식별자다.** breaking
  change(엔드포인트/경로 제거·변경, 요청 필수 필드 추가, 응답 필드
  제거·개명·타입 변경, 에러 응답 포맷 변경, 인증 방식 변경, HTTP 메소드
  변경, 상태 코드 의미 변경)가 필요해지면 컨트롤러 전체를 `api/v2/...`로
  교체한다. 옵셔널 필드 추가나 신규 엔드포인트 추가처럼 하위호환되는 변경은
  `v1` 안에서 그대로 반영한다(prefix 변경 없음).
- **`v1`과 `v2`를 동시에 노출하지 않는다.** Storix는 고객당 단일 인스턴스로
  배포되고(`ROADMAP.md` 목표), 업그레이드는 고객이 직접 트리거하는 원자적
  교체다(`docs/deployment/upgrade.md`) — 한 시점에 한 인스턴스가 서비스하는
  API 버전은 항상 하나뿐이다. 무중단 마이그레이션·멀티인스턴스 동시 지원은
  이미 `upgrade.md` "범위 밖"에 명시돼 있다. 따라서 breaking change 시 구
  버전 라우트는 같은 커밋에서 삭제하고 `v2`로 교체한다 — deprecation
  유예기간을 두지 않는다.
- **`openapi.yaml`의 `info.version`은 release 태그(`vX.Y.Z`, ADR-0007)를
  그대로 미러링하는 참고용 문자열이다.** API 경로의 `v1`/`v2`와는 독립된
  숫자 계열이며, `info.version`이 올라간다고 API 계약이 바뀌었다는 뜻은
  아니다(반대로 계약이 안 바뀌어도 release 태그는 계속 올라간다). 릴리즈
  절차(`docs/deployment/release.md` 1단계)에서 `CHANGELOG.md` 정리와 함께
  수기로 갱신한다.
- **이 정책은 지금 확정하지만, 스펙 콘텐츠(필드 모양)의 draft 상태는
  유지한다.** `apps/demo`가 아직 실사용 시나리오로 fs API를 검증하지
  않았다(`ROADMAP.md` "실행 순서" 3번 미완료 — `apps/demo/src`는 Vite
  스캐폴드 그대로다). `openapi.yaml`의 "초안 상태" 문구와 `info.version`의
  `-draft` 접미사 제거·1.0 확정은 그 검증이 끝난 뒤로 미룬다. 0.x 구간은
  ADR-0007이 정한 SemVer 규율상 MINOR bump로도 자유롭게 breaking change가
  가능하므로, 이 순서를 지켜도 정책 자체와 충돌하지 않는다.

## Considered Options

- **API 계약 버전과 release 태그를 하나로 통일**(`info.version` = `v1`
  prefix 숫자 = release 태그): self-host 단일 인스턴스라 매력적으로 보이지만,
  admin/demo 변경이나 버그 수정성 릴리즈마다 API 계약도 같이 올라간 것처럼
  보여 실제 계약 변경 여부를 태그만 보고 구분할 수 없게 된다. 보류.
- **`v1`/`v2` 병행 노출**(구버전 클라이언트를 위한 유예 기간): SaaS
  멀티테넌트라면 타당하지만, Storix는 "배포 단위는 고객별 단일
  인스턴스"(`ROADMAP.md` 목표)이고 호출 서버도 보통 자체 배포와 함께
  갱신되므로 병행 호스팅의 실익이 없다. 보류.
- **prefix 제거, release 태그만 사용**: 이미 코드에 박힌 `/api/v1/`을 걷어내는
  비용만 발생하고, 태그와 계약 버전을 구분 못 하는 문제는 위와 동일하게
  남는다. 보류.

## Consequences

- 다음 breaking change 때 `namespace.controller.ts`/`fs.controller.ts`의
  `@Controller` 데코레이터를 `api/v2/...`로 바꾸고, `openapi.yaml`의 `paths`도
  같은 커밋에서 `/api/v2/...`로 갱신해야 한다 — 두 곳 중 하나만 바뀌면
  `route-coverage.spec.ts`(ADR-0019)가 drift를 잡아준다.
- `apps/demo` 검증이 끝나 `openapi.yaml`의 draft 문구를 걷어낼 때, 이 ADR을
  수정하지 않고 새 ADR(또는 `CHANGELOG.md` 항목)로 "1.0 확정"을 기록한다 —
  ADR은 불변 로그로 취급한다(ADR-0016 컨벤션).
