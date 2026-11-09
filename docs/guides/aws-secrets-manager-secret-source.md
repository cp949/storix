# AWS Secrets Manager로 비밀값 전달하기

이 가이드는 Storix API 시작 시 AWS Secrets Manager의 `SecretString`을 `STORIX_API_KEY`에 전달하는 절차를 설명한다. 실제 AWS 계정에서 검증하지 않았으므로 계정·조직 정책에 맞게 점검한다.

## Secret 준비

`SecretString`에는 API 키 원문을 저장한다. JSON 객체 하나에 여러 값을 저장하고 키를 골라 쓰는 방법은 아래 "JSON Secret에서 키 고르기"를 따른다.

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

어댑터 패키지는 Storix 코어 dependency가 아니다. 릴리즈마다 어댑터가 들어 있는 `-aws` 태그 이미지를 발행한다.

```sh
docker pull ghcr.io/cp949/storix:vX.Y.Z-aws
```

`-aws` 태그는 v1.6.0부터 발행한다. v1.5.0 이하에는 없다. `-aws` 이미지는 같은 릴리즈의 기준 이미지에 `storix-secret-source-aws`만 더한다. `@aws-sdk/client-secrets-manager`는 이 이미지에만 있다.

소스에서 직접 만들려면 저장소 루트에서 기본 이미지와 어댑터 이미지를 빌드한다. 어댑터 Dockerfile은 저장소의 패키지 파일을 격리된 build stage에 복사하고 그 안에서 tarball을 만든 뒤 기준 이미지에 설치한다.

```sh
docker build --file apps/api/Dockerfile --tag storix-api:local .
docker build \
  --file packages/secret-source-aws/Dockerfile \
  --build-arg STORIX_BASE_IMAGE=storix-api:local \
  --tag storix-api:aws-secrets .
```

첫 명령 대신 `STORIX_BASE_IMAGE`에 사전 빌드 이미지 `ghcr.io/cp949/storix:vX.Y.Z`를 지정할 수 있다. AWS SDK 전이 dependency는 격리된 adapter stage에서 설치한다. `STORIX_BASE_IMAGE`에는 기본값이 없어 지정하지 않으면 빌드가 실패한다.

Storix API 컨테이너의 환경 설정은 다음과 같다.

```dotenv
AWS_REGION=ap-northeast-2
STORIX_SECRET_ADAPTERS=storix-secret-source-aws
STORIX_API_KEY=
STORIX_API_KEY_REF=aws-sm://arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:storix/api-key-AbCdEf
```

`STORIX_API_KEY`는 비워 기존 환경변수 방식과 충돌하지 않게 한다. 같은 Secret name을 쓸 수도 있다. 다른 AWS 계정 Secret에는 완전한 ARN을 지정한다.

AWS 설정에는 `STORIX_AWS_SM_ENDPOINT`, LocalStack Auth Token, 가짜 AWS access key를 지정하지 않는다. endpoint는 LocalStack 같은 호환 서버에만 사용한다. 실행 예제는 [LocalStack Secrets Manager 예제](../deployment/scenarios/aws-secrets-localstack/README.md)에서 확인한다.

## JSON Secret에서 키 고르기

참조 끝에 `#<키>`를 붙이면 `SecretString`을 JSON 객체로 읽어 그 키의 문자열 값만 반환한다. 키가 없는 참조는 이전처럼 `SecretString` 전체를 반환한다.

```sh
aws secretsmanager create-secret \
  --name storix/credentials \
  --secret-string '{"db-password":"실제-DB-비밀번호","api-key":"실제-API-키","admin-api-key":"실제-관리자-키"}' \
  --region ap-northeast-2
```

```yaml
# compose의 environment: (YAML)
environment:
  STORIX_DB_PASSWORD_REF: aws-sm://storix/credentials#db-password
  STORIX_API_KEY_REF: aws-sm://storix/credentials#api-key
  STORIX_ADMIN_API_KEY_REF: aws-sm://storix/credentials#admin-api-key
```

- 키는 `A-Z a-z 0-9 _ . -`만 허용하고 `#`은 하나만 쓴다. SecretId와 ARN에는 `#`이 들어갈 수 없어 구분이 모호하지 않다.
- 키 문법 밖의 키(공백, `:`, `@`, 비ASCII 등)는 고를 수 없다. 이런 키가 있는 Secret은 키 이름을 바꾼다.
- 값은 JSON 문자열이어야 한다. 숫자·불리언·`null`·객체·배열 값은 변환하지 않고 시작 실패로 처리한다.
- 값이 빈 문자열이면 어댑터는 그대로 돌려주고 코어가 `empty`로 시작을 실패시킨다.
- 어댑터는 값을 바꾸지 않는다. 끝에 줄바꿈이 붙지 않게 저장한다.
- `SecretString`이 JSON 객체가 아니거나 키가 없을 때도 시작 실패다. 오류 메시지에는 키 이름만 쓰고 Secret 내용은 쓰지 않는다.
- 변수마다 `GetSecretValue`를 한 번씩 호출한다. 같은 Secret을 가리키는 변수가 셋이면 세 번 호출하고, 권한은 그 Secret의 ARN 하나에 `GetSecretValue`를 주면 된다.
- Secret을 교체하는 도중에 시작하면 변수마다 다른 버전을 읽을 수 있다. 값이 서로 짝을 이루면 교체가 끝난 뒤 재시작한다.

**`.env` 파일에서는 참조를 큰따옴표로 감싼다.** Storix는 `.env`를 Node의 `loadEnvFile()`로 읽고, 따옴표 없는 값에서는 `#` 뒤를 주석으로 잘라 낸다. 잘리면 키 없는 참조가 되어 JSON 문자열 전체가 값으로 쓰이고, 오류 없이 시작할 수 있다.

```dotenv
# .env: 큰따옴표로 감싼다
STORIX_API_KEY_REF="aws-sm://storix/credentials#api-key"
```

다른 경로에서의 `#`과 따옴표 처리는 다음과 같다. 이 저장소에서 `docker run`과 `docker compose config`로 확인했다.

| 경로                          | `#`       | 큰따옴표              |
| ----------------------------- | --------- | --------------------- |
| Storix `.env` (`loadEnvFile`) | 뒤가 잘림 | 벗겨서 `#`을 보존한다 |
| compose `environment:`        | 값에 남음 | YAML이 벗긴다         |
| compose `env_file:`           | 값에 남음 | 벗긴다                |
| `docker run --env-file`       | 값에 남음 | 벗기지 않고 값에 포함 |

따옴표를 붙인 `.env`를 `docker run --env-file`에 그대로 쓰면 값이 `"aws-sm://…"`가 되어 `invalid-ref`로 시작에 실패한다. 같은 파일을 두 용도로 공유하지 않는다.

## 갱신과 한계

- Storix는 시작할 때 Secret의 기본 버전인 `AWSCURRENT`를 한 번 조회한다.
- Secret을 교체해도 실행 중인 Storix 값은 바뀌지 않는다. 새 값을 적용하려면 Storix를 재시작한다.
- 이 어댑터는 `SecretString`만 지원한다. `SecretBinary` 응답은 시작 실패가 된다.
- 키를 붙인 참조만 JSON을 파싱한다. 중첩 키 경로와 `VersionStage`·`VersionId` 선택은 지원하지 않는다.
- 키 선택은 이 기능이 들어간 릴리즈의 `-aws` 이미지부터 쓸 수 있다. `v1.6.0-aws`에는 없다. 포함 릴리즈는 `CHANGELOG.md`에서 확인한다.
- 조회한 값은 기존 SecretSource 동작에 따라 Storix 프로세스의 `process.env`에 저장된다. 같은 프로세스 권한으로 읽을 수 있다.
- 실제 AWS IAM·KMS·역할 연결·네트워크 동작은 이 저장소의 LocalStack 검증 범위에 포함되지 않는다.
