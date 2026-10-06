# AWS Secrets Manager 어댑터 예제

`storix-secret-source-aws-example`은 Storix의 `SecretSource` 계약을 구현하는 독립 예제 패키지다. AWS SDK는 이 패키지에만 포함하며 Storix 코어 dependency와 기본 이미지에는 추가하지 않는다.

## 동작

- 기본 export의 scheme은 `aws-sm`이다.
- `aws-sm://` 뒤의 전체 Secret name 또는 ARN을 `GetSecretValue`의 `SecretId`로 전달한다.
- `SecretString`을 변환하지 않고 반환한다. Binary 응답은 지원하지 않는다.
- 요청마다 SDK client를 만들고 `AbortSignal`을 전달한 뒤 정리한다.
- `AWS_REGION`은 필수다. `STORIX_AWS_SM_ENDPOINT`는 LocalStack 같은 호환 endpoint를 지정할 때만 사용한다.
- 자격 증명은 AWS SDK 기본 provider chain에서 가져온다.

## 검증

```sh
pnpm --dir examples/secret-source-aws test
pnpm --dir examples/secret-source-aws typecheck
pnpm --dir examples/secret-source-aws pack
```

배포할 때는 생성한 tarball과 AWS SDK 전이 dependency를 Storix 사용자 이미지에 설치한다. Storix API의 `STORIX_SECRET_ADAPTERS`에는 `storix-secret-source-aws-example`을 지정한다.

실행 예제와 실제 AWS 설정 절차는 저장소의 `docs/deployment/scenarios/aws-secrets-localstack/` 및 `docs/guides/aws-secrets-manager-secret-source.md`를 참고한다.
