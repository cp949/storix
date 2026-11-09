# AWS Secrets Manager 어댑터

`storix-secret-source-aws`는 Storix의 `SecretSource` 계약을 구현하는 독립 패키지다. `@aws-sdk/client-secrets-manager`는 이 패키지에만 포함하며 Storix 코어 dependency와 기본 이미지에는 추가하지 않는다. 릴리즈마다 `-aws` 태그 이미지(`ghcr.io/cp949/storix:vX.Y.Z-aws`)로 배포한다.

## 동작

- 기본 export의 scheme은 `aws-sm`이다.
- `aws-sm://` 뒤의 전체 Secret name 또는 ARN을 `GetSecretValue`의 `SecretId`로 전달한다.
- `SecretString`을 변환하지 않고 반환한다. Binary 응답은 지원하지 않는다.
- 참조 끝에 `#<키>`를 붙이면(`aws-sm://<SecretId>#<키>`) `SecretString`을 JSON 객체로 읽어 그 키의 문자열 값만 반환한다.
  - 키는 `[A-Za-z0-9_.-]+`다. `#`은 하나만 쓴다.
  - JSON 파싱 실패, JSON 객체가 아님, 키 없음(상속 속성 제외), 문자열이 아닌 값은 모두 거부한다. 오류 메시지에 Secret 내용을 쓰지 않는다.
  - `.env`에서는 `#` 뒤가 주석으로 잘리므로 참조를 큰따옴표로 감싼다.
- 요청마다 SDK client를 만들고 `AbortSignal`을 전달한 뒤 정리한다.
- `AWS_REGION`은 필수다. `STORIX_AWS_SM_ENDPOINT`는 LocalStack 같은 호환 endpoint를 지정할 때만 사용한다.
- 자격 증명은 AWS SDK 기본 provider chain에서 가져온다.

## 검증

```sh
pnpm --dir packages/secret-source-aws test
pnpm --dir packages/secret-source-aws typecheck
pnpm --dir packages/secret-source-aws pack
```

`-aws` 이미지를 쓰지 않고 직접 이미지를 만들 때는 생성한 tarball과 AWS SDK 전이 dependency를 Storix 이미지에 설치한다. Storix API의 `STORIX_SECRET_ADAPTERS`에는 `storix-secret-source-aws`를 지정한다.

실행 시나리오와 실제 AWS 설정 절차는 저장소의 `docs/deployment/scenarios/aws-secrets-localstack/` 및 `docs/guides/aws-secrets-manager-secret-source.md`를 참고한다.
