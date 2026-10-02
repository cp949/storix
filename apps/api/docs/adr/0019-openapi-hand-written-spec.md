# OpenAPI 스펙은 수기 YAML로 관리하고 `@nestjs/swagger` 데코레이터는 도입하지 않는다

`API-01`의 OpenAPI 스펙은 `apps/api/openapi.yaml`에 수기로 작성한다.
`@nestjs/swagger` 데코레이터는 도입하지 않는다.

## 결정 근거

- 기존 DTO(`create-namespace.dto.ts`, `node-response.dto.ts` 등)는 순수 TS 인터페이스와 수기 parse 함수를 사용한다.
- class-validator 데코레이터는 사용하지 않는다.
- `@ApiProperty` 등으로 스펙을 생성하려면 기존 DTO를 데코레이터 기반으로 바꿔야 한다.
- 채택 당시 스펙의 1차 용도는 사람이 읽는 참조 문서였다.
- SDK 코드생성이나 계약 테스트를 위한 DTO 변경 비용은 감수하지 않는다.

## Considered Options

- **`@nestjs/swagger` 데코레이터 도입**
  - 코드에서 스펙을 생성해 중복 관리와 drift 위험을 줄일 수 있다.
  - 기존 DTO 전체를 리팩토링해야 한다.
  - 채택 당시 참조 문서 용도에 비해 비용이 크다고 판단했다.

## Consequences

- 코드와 스펙을 별도 파일로 관리하므로 drift 위험이 있다.
- `test/openapi/route-coverage.spec.ts`로 컨트롤러 라우트와 스펙 `paths`를 대조한다.
- 채택 당시에는 파라미터·스키마 세부 정합성을 사람 리뷰에 맡겼다.
- 현재 테스트는 일부 공개 API의 필수 파라미터·응답 계약도 검사한다.
- SDK 코드생성이나 계약 테스트가 필요해지면 생성 방식의 재검토 조건이 된다.
- 후속 공개 HTTP 계약 검증은 ADR-0029에서 결정한다.
