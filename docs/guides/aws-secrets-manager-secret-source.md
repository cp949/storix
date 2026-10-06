# AWS Secrets Manager로 비밀값 전달하기

이 가이드는 Storix API 시작 시 AWS Secrets Manager의 `SecretString`을 `STORIX_API_KEY`에 전달하는 절차를 설명한다. 실제 AWS 계정에서 검증하지 않았으므로 계정·조직 정책에 맞게 점검한다.

## Secret 준비

`SecretString`에는 API 키 원문을 저장한다. JSON 객체를 저장해도 어댑터는 필드를 고르지 않고 JSON 문자열 전체를 반환한다.

```sh
aws secretsmanager create-secret \
  --name storix/api-key \
  --secret-string '실제-API-키-값' \
  --region ap-northeast-2
```

운영에서는 셸 기록이나 프로세스 인자에 실제 값을 남기지 않는 Secret 생성 절차를 사용한다. `--secret-string` 인자의 위치를 보여 준다.

## 권한

실행 역할에는 사용할 Secret의 ARN만 대상으로 `secretsmanager:GetSecretValue`를 허용한다. 아래 ARN은 실제 리전, 계정 ID, Secret 이름, 생성된 ARN 접미사로 바꾼다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:storix/api-key-AbCdEf"
    }
  ]
}
```

AWS 관리형 `aws/secretsmanager` 키를 쓰면 일반적으로 별도 KMS 권한을 추가하지 않는다. 고객 관리형 KMS 키를 쓰면 역할 정책에 해당 키의 `kms:Decrypt`를 허용하고 KMS key policy도 역할의 접근을 허용해야 한다. 필요하면 `kms:ViaService` 조건으로 Secrets Manager 경유 요청만 허용한다. [AWS GetSecretValue 권한](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html), [Secrets Manager 암호화와 KMS 권한](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html)

## 실행 역할 자격 증명

어댑터는 AWS SDK for JavaScript v3의 기본 credential chain을 사용한다. 클라이언트에 명시적 키를 설정하지 않는다.

- EC2에서는 애플리케이션 인스턴스에 필요한 권한만 가진 IAM role을 연결한다.
- ECS에서는 컨테이너에 필요한 권한만 가진 task role을 지정한다. task execution role은 애플리케이션의 Secrets Manager 호출 권한을 대신하지 않는다.
- EKS에서는 EKS Pod Identity 또는 IRSA로 ServiceAccount에 역할을 연결한다. Pod Identity는 지원되는 SDK와 EKS Pod Identity Agent가 필요하다.
- 로컬 개발에서는 AWS SDK 표준 credential chain이 인식하는 프로필을 사용할 수 있다. 장기 access key를 컨테이너 이미지에 넣지 않는다.

SDK는 설정된 provider chain에서 자격 증명을 찾는다. 환경 변수 자격 증명 등 앞선 provider가 선택되면 연결한 workload role이 사용되지 않을 수 있다. 배포 환경의 자격 증명 주입과 최소 권한을 확인한다. [AWS SDK credential chain](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html), [ECS task role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html), [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-minimum-sdk.html), [EKS IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)

## Storix 이미지와 설정

어댑터 패키지는 Storix 코어 dependency가 아니다. 예제 Dockerfile은 저장소의 패키지 파일을 격리된 build stage에 복사하고 그 안에서 tarball을 만든 뒤 사용자 이미지에 설치한다.

저장소 루트에서 기본 이미지와 어댑터 사용자 이미지를 빌드한다. `ghcr.io/cp949/storix:vX.Y.Z`는 사용할 릴리스 이미지 태그로 바꾼다.

```sh
docker build --file apps/api/Dockerfile --tag storix-api:local .
docker build \
  --file examples/secret-source-aws/Dockerfile \
  --build-arg STORIX_BASE_IMAGE=storix-api:local \
  --tag storix-api:aws-secrets .
```

첫 명령 대신 `STORIX_BASE_IMAGE`에 사전 빌드 이미지 `ghcr.io/cp949/storix:vX.Y.Z`를 지정할 수 있다. AWS SDK 전이 dependency는 격리된 adapter stage에서 설치한다. Compose나 배포 설정은 `storix-api:aws-secrets` 이미지를 사용한다.

Storix API 컨테이너의 환경 설정은 다음과 같다.

```dotenv
AWS_REGION=ap-northeast-2
STORIX_SECRET_ADAPTERS=storix-secret-source-aws-example
STORIX_API_KEY=
STORIX_API_KEY_REF=aws-sm://arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:storix/api-key-AbCdEf
```

`STORIX_API_KEY`는 비워 기존 환경변수 방식과 충돌하지 않게 한다. 같은 Secret name을 쓸 수도 있다. 다른 AWS 계정 Secret에는 완전한 ARN을 지정한다.

AWS 설정에는 `STORIX_AWS_SM_ENDPOINT`, LocalStack Auth Token, 가짜 AWS access key를 지정하지 않는다. endpoint는 LocalStack 같은 호환 서버에만 사용한다. 실행 예제는 [LocalStack Secrets Manager 예제](../deployment/scenarios/aws-secrets-localstack/README.md)에서 확인한다.

## 갱신과 한계

- Storix는 시작할 때 Secret의 기본 버전인 `AWSCURRENT`를 한 번 조회한다.
- Secret을 교체해도 실행 중인 Storix 값은 바뀌지 않는다. 새 값을 적용하려면 Storix를 재시작한다.
- 이 어댑터는 `SecretString`만 지원한다. `SecretBinary` 응답은 시작 실패가 된다.
- JSON을 파싱하거나 특정 필드를 선택하지 않는다.
- 조회한 값은 기존 SecretSource 동작에 따라 Storix 프로세스의 `process.env`에 저장된다. 같은 프로세스 권한으로 읽을 수 있다.
- 실제 AWS IAM·KMS·역할 연결·네트워크 동작은 이 저장소의 LocalStack 검증 범위에 포함되지 않는다.
