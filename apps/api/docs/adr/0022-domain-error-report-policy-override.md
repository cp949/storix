# 도메인 에러 shouldReport로 리포팅 정책을 클래스별로 override 가능하게 함

api ADR-0014는 `domain-error.filter.ts`의 500 분기에 에러 리포팅 정책을 두었다.
이 결정은 도메인 에러 클래스를 공유 `DomainError` 베이스로 옮기고 `shouldReport`를 추가한다.

- 기본값은 `status >= 500`일 때 `true`다.
- 개별 클래스는 `shouldReport`를 override할 수 있다.
- api ADR-0014를 대체하지 않는다.
- 기존 리포팅 규칙을 클래스 단위로 세분화하도록 확장한다.

## Considered Options

- **모든 서브클래스에 `shouldReport` 선언을 강제**:
  - 기본값을 두지 않는 안이다.
  - 도입 당시 도메인 에러는 6개 파일의 25개 클래스에 흩어져 있었다.
  - 기본 규칙에서 벗어나야 하는 클래스는 없었다.
  - 25곳의 선언만 늘어나므로 보류했다.
- **job의 catch 블록도 `shouldReport`를 적용**:
  - HTTP 요청 경로인 `DomainErrorFilter`와 같은 정책을 적용하는 안이다.
  - job 실패는 항상 report하는 운영 정책을 유지한다.
  - `restore-main.ts` 등의 catch 블록은 변경하지 않았다.
  - job 에러인 `RestoreTargetNotEmptyError`도 `DomainError`를 상속한다.
  - 이 job 경로에서는 `shouldReport`를 사용하지 않는다.
