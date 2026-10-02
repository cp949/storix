# PUBLIC namespace 다운로드 2개 라우트는 API key 인증 예외로 두고, 인가 실패는 404로 응답한다

api ADR-0007은 모든 API를 static API key로 보호하도록 정했다.
인가가 필요 없는 공개 자산도 다음 경로 중 하나로 내려받아야 했다.

- 호출 서버가 WAS에서 권한을 검사한 뒤 API key로 Storix를 대신 호출한다.
- 호출 서버가 presigned URL을 발급받아 클라이언트에 전달한다.

공개 자산에는 이 왕복이 불필요하다.
이 결정은 공개 다운로드에 한해 api ADR-0007에 예외를 둔다.

namespace에 불변 `accessPolicy`를 도입한다.

- 값은 `PRIVATE` 또는 `PUBLIC`이다.
- 기본값은 `PRIVATE`다.
- `encryptionPolicy`처럼 생성 시점에만 정한다(api ADR-0001).
- 생성 후 변경 API는 두지 않는다.

도입 당시 공개 라우트는 `api/v1/public/{namespaceId}/fs` prefix 아래로 한정했다.

- `GET .../content`: 인라인 응답.
- `GET .../download`: `Content-Disposition: attachment` 응답.
- 목록 조회(`ls`/`find`)와 쓰기 라우트는 두지 않는다.

공개 라우트는 별도 `PublicFsController`로 분리한다.
`@Public()` 메타데이터를 붙이고 `ApiKeyGuard`가 `Reflector`로 인증 우회 여부를 판단한다.
기존 API key 검증 로직은 유지한다(api ADR-0007).

인가 실패는 404 `NAMESPACE_NOT_FOUND`로 응답한다.
공개 라우트에는 호출자가 제시할 자격증명 개념이 없다.
401/403은 비공개 namespace의 존재 여부를 노출한다.
`PRIVATE` namespace와 존재하지 않는 namespace의 조회 실패를 같은 404로 처리한다.

`encryptionPolicy=ENCRYPTED`와 `accessPolicy=PUBLIC`의 조합은 두 계층에서 차단한다.

- namespace 생성 API는 400 `NAMESPACE_PUBLIC_ENCRYPTION_CONFLICT`로 거부한다.
- DB는 `CHK_namespace_public_not_encrypted` CHECK 제약으로 거부한다.

애플리케이션 검증만으로는 금지된 조합이 저장되지 않는다고 보장할 수 없다.
스키마에서도 암호화 콘텐츠가 복호화 없이 무인증으로 나가는 경로를 막는다.

## Considered Options

- **기존 `/api/v1/namespaces/{id}/fs/...` URL을 재사용**:
  - `ApiKeyGuard`가 요청마다 `accessPolicy`를 조회해 인증 우회 여부를 판단한다.
  - 엔드포인트를 추가하지 않아도 된다.
  - 인증 Guard가 DB 조회에 의존한다.
  - api ADR-0007의 키 비교만으로 끝나는 구조가 바뀐다.
  - 리버스 프록시가 URL만으로 공개·비공개 트래픽을 분리할 수 없다.
  - 배포 계층에서 공개 라우트의 노출 범위를 좁히기 어려워 기각했다.
  - 배포 예시는 `docs/deployment/scenarios/co-located-nginx-mtls`다.

## Consequences

- `AuditLogInterceptor`도 `@Public()` 메타데이터가 있으면 기록을 건너뛴다(api ADR-0010).
  공개 요청은 `audit_log`에 남지 않는다.
  감사 로그가 완전한 기록은 아니라는 기존 한계가 유지된다.
- 공개 라우트에는 Storix 자체의 rate limit이 없다.
  남용 방지는 앞단 nginx/LB가 담당한다.
  예시는 `docs/deployment/scenarios/co-located-nginx-mtls/nginx/storix-public-api.location.conf`다.
- `PUBLIC` 콘텐츠는 URL과 경로를 아는 누구나 접근할 수 있다.
  `accessPolicy`에는 만료가 없다.
  생성 후 변경할 수 없다.
  비공개로 전환하려면 새 `PRIVATE` namespace로 데이터를 옮겨야 한다(api ADR-0001과 같은 제약).
- `PUBLIC` namespace에는 운영자가 공개 origin에서 그대로 서빙하도록 허용한 바이트만 둔다.
  신뢰할 수 없는 제3자의 업로드도 같은 기준을 적용한다.
  `content-response.ts`의 `nosniff`와 CSP는 top-level document의 스크립트 실행을 막는다.
  콘텐츠 자체는 누구나 읽거나 링크할 수 있다.
- namespace 삭제의 `status` 검사는 인증 경로와 무인증 경로에 모두 적용해야 한다.
  도입 당시 대상은 `getRootWithLimits()`를 쓰는 `FsController`와 `PublicFsController`의 두 경로였다.
  한쪽만 검사하면 삭제된 namespace가 공개 경로로 계속 서빙될 수 있다.
  공개 요청은 감사 로그도 없어 이 회귀를 발견하기 어렵다.
