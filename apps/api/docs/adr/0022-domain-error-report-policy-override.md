# 도메인 에러 shouldReport로 리포팅 정책을 클래스별로 override 가능하게 함

ADR-0014는 에러 리포팅을 `domain-error.filter.ts`의 500 분기 하나로 고정된
전역 규칙으로 기록했다. 6개 파일에 흩어진 25개 도메인 에러 클래스를 공유
`DomainError` 베이스로 재배치하면서 `shouldReport` 필드를 추가한다 — 기본값은
ADR-0014의 규칙(`status >= 500` → true)을 그대로 재현하되, 개별 클래스가
override할 수 있는 자리를 만든다. ADR-0014를 대체하지 않으며, 그 안의 500-분기
규칙을 클래스 단위로 세분화할 수 있게 확장하는 결정이다.

## Considered Options

- **`shouldReport`를 모든 서브클래스가 명시적으로 선언하도록 강제(default
  없음)**: 지금 25개 클래스 중 ADR-0014의 기본 규칙에서 벗어나야 하는 케이스가
  없어 25곳을 기계적으로 건드리는 diff만 커지므로 보류했다.
- **`shouldReport`를 HTTP 요청 경로(`DomainErrorFilter`)에서만 의미 있게
  두고, job 엔트리포인트(`restore-main.ts` 등)의 catch 블록도 이 필드를
  존중하도록 같이 고침**: job 실패는 무조건 report하는 게 운영상 맞는 정책이라
  일부러 그대로 두었다 — `DomainError`를 상속하는 job 에러(`RestoreTargetNotEmptyError`)에서
  `shouldReport`는 지금 소비자가 없는 필드로 남는다.
