# PUBLIC namespace 다운로드 2개 라우트는 API key 인증 예외로 두고, 인가 실패는 404로 응답한다

ADR-0007은 "모든 API는 static API key로 보호한다"고 정했다. 그런데 인가가 필요 없는
공개 자산을 서비스하는 namespace가 생기면서, 호출 서버가 WAS에서 권한을 검사한 뒤
API key로 Storix를 대신 호출하거나 presigned URL을 발급받아 클라이언트에 넘기는
두 경로 모두 공개 자산 하나 내려받는 데 불필요한 왕복이 됐다. 이 ADR은 그 경우에
한해 ADR-0007에 예외를 추가한다.

namespace 단위로 불변 `accessPolicy`(`PRIVATE`/`PUBLIC`, 기본값 `PRIVATE`)를 도입한다.
`encryptionPolicy`(ADR-0001)와 같은 방식으로 생성 시점에만 결정하고 이후 변경하는
API를 두지 않는다. 공개 표면은 `api/v1/public/{namespaceId}/fs` prefix 아래 다운로드
라우트 2개(`GET .../content` 인라인, `GET .../download` 는 `Content-Disposition:
attachment`)로 한정하고, 목록 조회(`ls`/`find`)나 쓰기 라우트는 두지 않는다. 기존
`ApiKeyGuard`(ADR-0007)는 수정하지 않고, `@Public()` 메타데이터를 붙인 별도
`PublicFsController`로 분리해 그 Guard가 `Reflector`로 우회 여부를 판단하게 한다 —
인증 로직 자체를 건드리지 않고 표면만 추가하는 형태를 유지하기 위함이다.

인가 실패는 401이 아니라 404(`NAMESPACE_NOT_FOUND`)로 응답한다. 공개 표면에는 애초에
제시할 자격증명 개념이 없고, 401/403을 반환하면 "namespace가 존재하긴 하는데
비공개"임을 노출하는 오라클이 된다. `PRIVATE` namespace, 존재하지 않는 namespace,
그 외 어떤 사유로도 조회에 실패한 경우를 전부 같은 404로 합친다.

`encryptionPolicy=ENCRYPTED`와 `accessPolicy=PUBLIC`의 조합은 두 곳에서 동시에
차단한다. namespace 생성 API가 이 조합을 `NAMESPACE_PUBLIC_ENCRYPTION_CONFLICT`로
400 거부하고, DB에도 `CHK_namespace_public_not_encrypted` CHECK 제약을 같은 조건으로
둔다. 애플리케이션 계층 검증만으로는 이 조합이 생기지 않는다는 보장이 안 되므로,
암호화된 콘텐츠가 복호화 없이 무인증으로 나가는 경로를 스키마 수준에서도 막는다.

## Considered Options

- **기존 `/api/v1/namespaces/{id}/fs/...` URL을 재사용하고 `ApiKeyGuard`가 요청마다
  namespace의 `accessPolicy`를 조회해 우회 여부를 판단**: 엔드포인트를 늘리지 않는다는
  장점은 있지만, 인증 Guard가 DB 조회에 의존하게 되어 ADR-0007이 지켜온 "키 슬라이스
  비교만으로 끝나는" 단순성이 깨진다. 무엇보다 nginx 같은 리버스 프록시가 URL만 보고
  공개/비공개 트래픽을 분리할 수 없어, 배포 계층에서 공개 표면의 노출 범위를 좁히는
  선택지(`docs/deployment/scenarios/co-located-nginx-mtls`)를 잃는다. 기각.

## Consequences

- `AuditLogInterceptor`(ADR-0010)도 같은 `@Public()` 메타데이터를 보고 요청을
  건너뛰므로, 공개 표면으로 들어온 요청은 `audit_log`에 남지 않는다 — ADR-0010이 이미
  남긴 "완전한 기록으로 오해하면 안 됨" 한계의 연장이다.
- 공개 표면에는 Storix 자체의 rate limit이 없다. 남용 방지는 앞단 nginx/LB의 책임이며,
  `docs/deployment/scenarios/co-located-nginx-mtls/nginx/storix-public-api.location.conf`가
  그 경계를 예시한다.
- namespace를 `PUBLIC`으로 만들면 그 콘텐츠는 URL과 경로를 아는 누구나 영구적으로
  접근 가능하다는 뜻이다. `accessPolicy`는 생성 후 변경할 수 없으므로, 되돌리려면
  새 `PRIVATE` namespace를 만들고 데이터를 옮겨야 한다(ADR-0001과 같은 제약 형태).
- `PUBLIC` namespace에는 신뢰할 수 없는 제3자가 올린 바이트를 두면 안 된다 —
  운영자가 "이 바이트를 공개 origin에서 그대로 서빙해도 된다"고 받아들인 경우가
  아니라면. `content-response.ts`의 `nosniff` + CSP 헤더는 그런 콘텐츠가
  top-level document로 열렸을 때 스크립트가 실행되는 것은 막아 주지만, 콘텐츠
  자체는 여전히 누구나 읽을 수 있고 영구적으로 링크 가능한 상태로 남는다.
- namespace 삭제 기능을 구현할 때는 `status` 필터링을 `getRootWithLimits()`의
  두 호출자 모두에 추가해야 한다 — 인증 경로(`FsController`가 쓰는 경로)와
  무인증 경로(`PublicFsController`가 쓰는 경로) 둘 다. 한쪽만 고치면 삭제된
  namespace가 공개 경로로는 계속 서빙되는 회귀가 생기는데, 이 표면은 감사
  로그도 남지 않아(위 항목) 발견이 더 늦어진다.
