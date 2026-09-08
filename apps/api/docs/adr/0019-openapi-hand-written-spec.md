# OpenAPI 스펙은 수기 YAML로 관리하고 `@nestjs/swagger` 데코레이터는 도입하지 않는다

API-01에서 `apps/api/openapi.yaml`을 수기로 작성하기로 했다. 기존 DTO(`create-namespace.dto.ts`,
`node-response.dto.ts` 등)는 class-validator 데코레이터 없이 순수 TS 인터페이스 + 수기 parse
함수 패턴을 쓰고 있어, `@nestjs/swagger`의 `@ApiProperty` 등으로 스펙을 자동 생성하려면 모든
DTO를 데코레이터 기반으로 리팩토링해야 한다. 스펙의 1차 용도가 사람이 읽는 참조 문서이고
SDK 코드생성이나 계약 테스트가 아니므로, 그 비용을 지금 감수할 이유가 없다.

## Considered Options

- **`@nestjs/swagger` 데코레이터 도입**: 코드가 소스 오브 트루스가 되어 drift가 구조적으로
  불가능해지지만, 기존 DTO 전체를 리팩토링해야 하고 현재 스펙 용도(참조 문서)에 비해
  비용이 크다.

## Consequences

- 코드와 스펙이 별개 파일이라 drift 위험이 있다 — 컨트롤러 라우트 목록과 스펙 `paths`가
  어긋나지 않는지만 가벼운 테스트(`src/openapi/route-coverage.spec.ts`)로 자동 검증하고,
  파라미터·스키마 세부 정합성은 사람 리뷰에 맡긴다.
- SDK 코드생성이나 계약 테스트가 나중에 필요해지면 이 결정을 재검토해야 한다.
