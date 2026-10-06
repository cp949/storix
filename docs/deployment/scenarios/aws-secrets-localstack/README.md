# LocalStack Secrets Manager 예제

이 예제는 `STORIX_API_KEY_REF`를 통해 AWS Secrets Manager API에서 API 키를 읽고 Storix를 시작한다. 실제 AWS 계정은 사용하지 않는다.

## 준비

- Docker Engine과 `docker compose`가 실행 중이어야 한다.
- Node.js 24와 pnpm 11이 필요하다.
- `pass`에 LocalStack Auth Token을 `localstack/auth-token`으로 저장해야 한다. 셸에서 이미 `LOCALSTACK_AUTH_TOKEN`을 설정했다면 그 값을 사용한다.
- 첫 실행에는 Storix, LocalStack, VersityGW, AWS CLI 이미지를 내려받는다.

테스트 API 키와 마스터 키는 예제 전용 공개 값이다. 운영 환경에서 사용하지 않는다.

## 실행

저장소 루트에서 실행한다.

```sh
bash docs/deployment/scenarios/aws-secrets-localstack/run.sh
```

스크립트는 기본 Storix 이미지와 AWS 어댑터 사용자 이미지를 만들고, 전용 Compose project에서 LocalStack Secret 생성, SQLite migration, Storix 기동을 진행한다. API 확인은 정상 키 `200`·배열, 다른 키 `401`, 키 없는 요청 `401`을 확인한다. 끝나면 전용 컨테이너와 볼륨을 제거한다.

LocalStack Auth Token은 LocalStack 서비스에만 전달한다. Storix 컨테이너에는 토큰이나 테스트 API 키를 환경 설정으로 넣지 않는다. API 키는 `secret-init` 서비스가 LocalStack에 저장한다.

## 검증

개발 검증은 다음 명령으로 실행한다.

```sh
node docs/deployment/scenarios/aws-secrets-localstack/verify.mjs
```

이 검증은 정상 요청, 없는 Secret의 값 없는 시작 실패, Storix 설정·초기 프로세스 환경·컨테이너 로그의 값 비노출, `gc`·`backup`·`restore` timeout 종료, 재실행과 전용 리소스 정리를 확인한다.

Dockerfile이나 어댑터 이미지 내용에 변경이 없고 기존 예제 이미지를 재사용할 때는 `node docs/deployment/scenarios/aws-secrets-localstack/verify.mjs --skip-build`을 실행한다.

LocalStack은 AWS Secrets Manager 호환 API 흐름을 확인한다. 실제 AWS IAM·KMS·자격 증명 체인·네트워크 동작을 검증하지 않는다.

## 정리

정상 종료와 실패 시 스크립트가 해당 실행의 Compose project만 `down --volumes`로 정리한다. 중단 뒤 리소스가 남으면 출력된 `project` 이름을 사용해 저장소 루트에서 정리한다.

```sh
project=storix-secret-source-localstack-<run-id>
docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f
docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm
docker network ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker network rm
```

`<run-id>`는 실행 출력의 `project=...`에 표시된 project 이름에서 접두어 `storix-secret-source-localstack-` 뒤에 오는 값으로 바꾼다.

위험도: 낮음 (전용 project의 테스트 DB·스토리지 볼륨에 한정)
롤백: 테스트 리소스를 다시 만들 수 있다. 삭제한 데이터 자체는 복구하지 않는다.
