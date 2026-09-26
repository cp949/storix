# VFS 선택 capability

기존 VFS-01 파일 API는 항상 활성이다. 이후 추가하는 선택 기능은 소비자 사용 사례를 완성하는 연산 묶음을 하나의 capability로 등록한다. 선택 capability의 기본 상태는 비활성이다. 현재 production registry는 비어 있고 등록된 선택 기능은 없다. 인증된 `GET /api/v2/namespaces/{id}/capabilities`는 ACTIVE namespace의 실제 활성 선택 capability ID를 조회한다.

## 시작 설정

`apps/api`는 시작할 때 `STORIX_VFS_CAPABILITIES_CONFIG_PATH`가 가리키는 UTF-8 JSON 파일을 한 번 읽는다. 상대 경로는 프로세스 작업 디렉터리 기준으로 해석한다. 환경 변수가 없거나 빈 문자열이면 `globalAllowedCapabilities: []`, `namespaceAllowedCapabilities: {}`를 적용한다. 경로가 지정되면 파일 읽기·JSON 파싱·schema 검증 실패로 시작을 거부한다. 운영 중 reload·설정 변경 API는 없다.

```json
{
  "globalAllowedCapabilities": [],
  "namespaceAllowedCapabilities": {}
}
```

두 최상위 필드는 필수이며 추가 필드는 허용하지 않는다. 전역 필드는 capability ID 문자열 배열, namespace 필드는 namespace UUID를 키로 하고 capability ID 문자열 배열을 값으로 하는 객체다. namespace UUID는 소문자로 정규화하며 정규화 후 중복된 키는 거부한다. namespace ID가 실제 DB에 없으면 시작을 거부한다. capability ID는 소문자 `kebab-case` 단일 식별자다. 별칭이나 대소문자 정규화는 없다.

## Registry와 활성 판정

capability 정의는 코드의 정적 registry에 등록한다. 정의에는 namespace 범위, 기본 비활성, 전역 상한과 namespace 명시적 허용, 의존 capability, 비활성 오류, 데이터 보존, 유효 상태 조회 노출 정책이 포함된다. 중복 ID, 잘못된 메타데이터, 미등록·자기·순환 의존성은 시작 오류다. 설정에 미등록 ID가 있어도 시작을 거부한다. production registry가 비어 있는 현재에는 ID를 포함한 설정 파일이 시작 오류다.

capability가 활성인 조건은 registry 등록, 전역 허용 목록 포함, 대상 namespace 허용 목록 포함, 모든 의존 capability 활성이다. namespace 설정은 전역 차단을 해제할 수 없고, 설정이 없는 namespace의 선택 기능은 비활성이다. 활성 capability에 필요한 의존성이 전역 또는 해당 namespace에서 허용되지 않으면 시작을 거부한다.

## 요청 오류와 데이터 경계

선택 기능의 route는 `CapabilityService.requireEnabled(namespaceId, capabilityId)`로 활성 상태를 요구한다. 비활성이면 HTTP 409 `VFS_FEATURE_DISABLED`를 반환하고 메시지에 capability ID를 담는다. 결정적 조건부 변경 오류는 기존 mutation receipt 규칙에 따라 최초 응답을 저장·재생한다. 현재는 등록된 선택 capability와 해당 route가 없어 이 오류를 발생시키는 공개 선택 기능 endpoint도 없다.

기능을 비활성화해도 이미 저장한 데이터는 삭제하거나 숨기지 않는다. 해당 데이터의 안전한 조회·내보내기·복구·삭제 경로는 계속 사용할 수 있어야 한다. 기존 파일 API에는 capability 전역 차단을 적용하지 않는다. 각 선택 기능을 추가할 때 이 경계를 함께 설계한다. 소비자별 인증·ACL과 DB schema 변경은 이 설정 계층의 책임이 아니다.

## 활성 capability 조회

조회 API는 전역 서비스 Bearer key로 인증한다. 서비스 key는 namespace별 ACL을 제공하지 않으므로 key 보유자는 모든 ACTIVE namespace를 조회할 수 있다. 잘못된 UUID, 없는 namespace, `DELETING`·`DELETED` namespace는 모두 404 `NAMESPACE_NOT_FOUND`다. 기존 namespace 단건 조회의 상태 정책은 이 endpoint 때문에 바뀌지 않는다.

응답은 `{ "capabilities": string[] }`이며 등록 ID 중 기존 `isEnabled()` 판정이 참인 선택 capability만 사전순으로 포함한다. 전역·namespace 허용과 의존성 판정을 그대로 적용하고, 실제 활성 의존 ID도 목록에 들어간다. 기본 파일 API는 포함하지 않는다. 설정 원문(전역만 허용하거나 namespace에만 적은 ID)은 노출하지 않으며, registry의 `discoveryVisibility: effective-state`가 이 판정 결과만 노출하는 정책을 뜻한다. Production registry가 비어 있거나 namespace에 활성 ID가 없으면 `200 { "capabilities": [] }`이고 `Cache-Control: no-store`를 반환한다.

활성 ID는 프로세스 시작 때 읽은 설정 snapshot에 대한 결과다. 설정 변경은 기존과 같이 재시작 이후 적용되며 조회 시점에 설정을 다시 읽지 않는다. 상세 공개 계약은 `apps/api/openapi.yaml`을 따른다.
