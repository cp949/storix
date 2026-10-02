# 소비자 요구와 Storix 계약

- Storix는 특정 호출 서버에 종속되지 않는 독립 저장 서비스다.
- 특정 소비자에서 시작한 요구도 지원 범위에 포함할 수 있다.
- Storix의 저장 책임에 맞고 다른 소비자도 사용할 수 있는 개념은 범용 계약으로 지원한다.
- Jupyter의 파일 저장 요구도 같은 기준으로 평가한다.

## 기능 수용 기준

소비자 요구는 프로젝트 이름이 아니라 요구하는 개념과 책임을 기준으로 평가한다.

- 여러 소비자에게 재사용할 수 있는 저장 의미는 Storix의 범용 API와 도메인 기능으로 표현한다. 조건부 변경, revision, idempotent mutation receipt, 파일·트리 snapshot 같은 기능이 이에 해당한다.
- 소비자의 인증·권한, 업무 식별자, HTTP 응답 모양처럼 소비자 경계에 속하는 의미는 Storix 내부 도메인과 섞지 않는다.
- 소비자의 wire 계약이 Storix의 독립성이나 다른 소비자 계약을 훼손하면 공통 저장 의미만 제공한다. 소비자 어댑터는 이를 자신의 계약으로 변환한다.
- 범용 기능이 소비자의 정확한 요구를 모두 충족하지 못하면 그 차이와 어댑터 책임을 문서화한다. 이를 Storix에서 지원 완료로 표시하지 않는다.

재사용 가능한 저장 개념은 Storix가 지원한다. 소비자별 응답 형식과 계약 변환은 각 소비자 경계에서 처리한다.

## 검증 경계

- Storix 검증은 공개 API가 약속한 범용 의미를 대상으로 한다.
- 소비자 통합 검증은 어댑터가 해당 의미를 소비자 계약으로 정확히 바꾸는지 별도로 확인한다.
- Storix 단위·통합 테스트만으로 특정 소비자의 HTTP 동작이나 실제 배포 연동이 검증됐다고 간주하지 않는다.

- Jupyter 파일 API에 필요한 범용 저장 정보는 조건부 콘텐츠 결과의 파일 ID·revision, `GET /fs/stat`의 파일 메타데이터, 인증된 전체 `GET /fs/content`의 파일 ID·revision·SHA-256 헤더, FILE snapshot의 원본 파일 ID·보존 바이트 SHA-256으로 공개한다.
- 파일 ID는 이동·이름 변경·내용 교체 후 유지되는 VFS 노드 UUID이고 revision은 동등성 비교용 불투명 토큰이다.
- 범용 조건부 변경과 mutation receipt도 Storix 계약이다.
- Bearer 인증, 프로젝트 ACL, Jupyter 응답 status·header·body 조립은 bbcode 책임이다.
- Storix의 전체 콘텐츠 식별 헤더는 부분 조회, 공개 파일 경로, 다운로드에 적용되지 않는다.

- 소비자가 자기 wire 응답의 최초 결과를 보장해야 한다면, 그 응답을 조립하는 소비자 adapter가 status·안정 헤더·body를 자체 identity로 보존하고 재생한다.
- Storix receipt는 Storix API의 응답을 보존한다.
- 예를 들어 Storix의 `X-Request-Id` 재생만으로 Jupyter 응답 전체가 재생된다고 간주하지 않는다.
- 이 구분은 receipt 자체를 Storix에서 확장하지 못하게 하는 규칙이 아니다.
- 다른 소비자에도 유용한 receipt capability는 Storix의 범용 계약으로 제공할 수 있으며, 소비자별 wire 응답 의미는 해당 adapter가 구성한다.
