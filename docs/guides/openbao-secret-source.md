# OpenBao로 비밀값 전달하기

이 가이드는 Storix 시작 시 OpenBao KV v2의 값을 `X_REF`로 읽는 절차를 설명한다. 어댑터는 `storix-secret-source-bao`이고, 릴리즈마다 `-bao` 태그 이미지로 발행한다. 계약은 [비밀값 소스](../design/15-secret-sources.md)를 따른다.

upstream CI는 가짜 OpenBao 서버로만 어댑터를 검증한다. 실제 OpenBao 서버와 사설 CA HTTPS는 upstream에서 확인하지 않았다.

## 이미지

```sh
docker pull ghcr.io/cp949/storix:vX.Y.Z-bao
```

`-bao` 태그는 v1.6.0부터 발행한다. v1.5.0 이하에는 없다. `-bao` 이미지는 같은 릴리즈의 기준 이미지에 어댑터만 더한다. 어댑터는 npm 의존성이 없다. Node의 `fetch`로 OpenBao를 호출한다.

## 참조 형식

`bao://<마운트>/<경로>#<필드>` 예: `bao://kv/example/storix#api_key`

- 마운트와 경로 구성 요소는 `A-Z a-z 0-9 _ . -`만 허용한다. `.`과 `..`, 빈 구성 요소는 거부한다.
- 경로는 한 단계 이상이다.
- 필드는 `A-Z a-z 0-9 _ . -`만 허용한다. `#`은 하나뿐이다.
- 형식이 틀리면 서버를 호출하지 않고 `invalid-ref`로 실패한다.

## 설정

| 변수                     | 내용                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `STORIX_SECRET_ADAPTERS` | `storix-secret-source-bao`. Storix 코어가 어댑터를 불러오는 설정이다                 |
| `BAO_ADDR`               | OpenBao 주소. 끝의 `/`는 무시한다                                                    |
| `BAO_AUTH_METHOD`        | 로그인 방식. 기본값 `approle`. 지원하지 않는 값이면 `auth-method`로 실패한다         |
| `BAO_ROLE_ID`            | AppRole의 `role_id`. 비밀이 아니다                                                   |
| `BAO_SECRET_ID_FILE`     | `secret_id`를 담은 파일 경로. 끝 줄바꿈(`\n`, `\r\n`) 하나를 제거한다                |
| `NODE_EXTRA_CA_CERTS`    | 사내 CA 파일 경로. Node가 OpenBao 리스너 인증서를 검증하는 데 쓴다. Node 표준 변수다 |

```dotenv
STORIX_SECRET_ADAPTERS=storix-secret-source-bao
BAO_ADDR=https://openbao.example.internal:8200
BAO_ROLE_ID=00000000-0000-0000-0000-000000000000
BAO_SECRET_ID_FILE=/run/secrets/bao_secret_id
STORIX_API_KEY=
STORIX_API_KEY_REF=bao://kv/example/storix#api_key
```

- `X`와 `X_REF`를 함께 두면 기동이 실패한다. 해당 `X`는 비우거나 지운다.
- `secret_id` 파일은 compose `secrets:` 등으로 마운트한다. 호스트 파일 권한은 600으로 둔다. 이미지에 넣지 않는다.
- `X_REF`와 `STORIX_SECRET_ADAPTERS`는 기본 compose가 컨테이너로 전달하지 않는다. 사용하는 서비스(`app`, `gc`, `migrate` 등)의 `environment:`에 직접 지정한다. 자세한 범위는 [비밀값 소스](../design/15-secret-sources.md)의 "compose 전달 범위"를 따른다.

## 동작

1. 참조를 파싱한다.
2. 프로세스 안에서 로그인을 한 번 한다. 같은 프로세스의 나머지 `resolve` 호출은 토큰을 재사용한다. 로그인이 실패하면 다음 호출이 다시 시도한다.
3. `GET <BAO_ADDR>/v1/<마운트>/data/<경로>`를 호출하고 `data.data[필드]`를 돌려준다.
4. 값이 문자열이 아니거나 비어 있으면 `bad-response`로 실패한다.
5. `signal`을 모든 HTTP 호출에 전달한다. 중단되면 `aborted`로 실패한다.

토큰 갱신, 응답 캐시, 여러 필드를 한 번에 읽는 최적화는 없다. 별도 프로세스(`gc`, `backup`, `restore`)는 실행마다 로그인한다.

## 오류 종류

어댑터의 오류 메시지에는 아래 종류만 쓴다. 값, 토큰, `secret_id`, 참조의 필드명은 쓰지 않는다.

| 종류           | 원인                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| `invalid-ref`  | 참조 형식 오류                                                                |
| `config`       | `BAO_ADDR`가 없다                                                             |
| `auth-config`  | `BAO_ROLE_ID`나 `BAO_SECRET_ID_FILE`이 없거나, 파일을 읽을 수 없거나 비었다   |
| `auth-method`  | 지원하지 않는 `BAO_AUTH_METHOD`                                               |
| `auth-failed`  | 로그인이 400이나 403이다(잘못된 `secret_id`, AppRole의 CIDR 제한 불일치 포함) |
| `not-found`    | 경로나 필드가 없다                                                            |
| `forbidden`    | 읽기 권한이 없다(403)                                                         |
| `bad-response` | JSON이 아니거나, 토큰·값이 문자열이 아니거나 비었거나, 그 밖의 상태 코드다    |
| `network`      | 접속할 수 없다                                                                |
| `aborted`      | `signal`이 중단됐다                                                           |

Storix 코어는 어댑터 오류를 `adapter-error`로만 로그에 쓴다. 로그만으로 네트워크 오류와 인증 오류를 구분할 수 없다.

## 값 저장 규칙

- 값은 끝에 줄바꿈 없이 저장한다. 어댑터는 값을 바꾸지 않고 돌려준다. Storix 코어도 줄바꿈을 제거하지 않는다.
- 값을 저장하는 쪽(스크립트, CLI)이 줄바꿈 없이 써야 한다.

## 권한

AppRole에는 사용할 경로의 `read`만 허용한다. KV v2의 정책 경로는 `<마운트>/data/<경로>`다.

```hcl
path "kv/data/example/storix" {
  capabilities = ["read"]
}
```

## 한계

- OpenBao가 멈추면 Storix가 기동하지 못한다. 실행 중에는 영향이 없다.
- 실행 중 비밀값 교체는 지원하지 않는다. 새 값을 적용하려면 Storix를 재시작한다.
- `secret_id` 파일은 호스트에 남는다. 유출 시 OpenBao에서 `secret_id`를 재발급해 이전 값을 폐기한다.
- 사설 CA로 서명한 OpenBao 리스너 인증서를 `NODE_EXTRA_CA_CERTS`로 검증하는 경로는 upstream CI에서 확인하지 않았다. 배포 환경에서 `docker run`으로 한 번 해석해 확인한다.
- 지원하는 로그인 방식은 AppRole뿐이다.
