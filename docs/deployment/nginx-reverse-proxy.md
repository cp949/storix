# nginx reverse-proxy 참조 구성

STORAGE-03. 공개 도메인 → nginx → 내부 VersityGW 구성이다.
결정은 [ADR-0002](../adr/0002-nginx-reverse-proxy-sample.md)를 따른다.

presigned download URL(STORAGE-02)은 발급 시점 Client의 host·port·scheme으로 서명한다.
프록시는 원본 Host 헤더와 쿼리스트링을 VersityGW에 그대로 전달한다.
TLS 종료 뒤에도 서명에 사용한 값을 보존해야 한다.

## 구성 파일

| 파일                                                   | 역할                                                     |
| ------------------------------------------------------ | -------------------------------------------------------- |
| [nginx-reverse-proxy.conf](./nginx-reverse-proxy.conf) | 로컬 재현과 운영 설정의 기준이 되는 nginx 설정           |
| [compose.nginx-demo.yml](./compose.nginx-demo.yml)     | nginx와 self-signed 인증서 생성 서비스 `nginx-cert-init` |

- demo Compose는 개발·검증용이다.
- Storix 필수 구성이 아니므로 루트 `docker-compose*` 목록에 두지 않는다.
- 샘플의 `proxy_pass`는 `http://versitygw:7070`으로 고정한다.
- `docker-compose.versitygw.yml` 조합에서만 동작한다.

공개 경로 경계:

- 샘플은 서명 검증 재현을 위해 `location /`의 GET을 VersityGW로 전달한다.
- 운영에서는 실제 presigned URL의 bucket 경로만 공개 listener에 라우팅한다.
- Storix 보호 API는 WAS 전용 내부 경로에 둔다.
- nginx의 메서드 제한은 서명 검증을 대체하지 않는다.
- bucket은 비공개로 유지한다.
- 사용처 경계는 [WAS 다운로드 가이드](../guides/was-file-download-patterns.md)를 따른다.

## 로컬 재현 (docker-compose)

```bash
export STORIX_API_KEY=$(openssl rand -hex 32)
export STORIX_STORAGE_PUBLIC_ENDPOINT=localhost
export STORIX_STORAGE_PUBLIC_PORT=8443
export STORIX_STORAGE_PUBLIC_USE_SSL=true
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml \
  -f docs/deployment/compose.nginx-demo.yml up -d --wait
```

인증서와 포트:

- `nginx-cert-init`은 기동 시 self-signed 인증서를 만든다.
- 인증서는 `nginx-certs` 볼륨에 저장한다.
- nginx는 호스트 `${STORIX_NGINX_PUBLIC_PORT:-8443}`에서 컨테이너 443으로 연결한다.
- 인증서 CN/SAN은 `localhost`다.
- 다른 hostname으로 접속하면 TLS 클라이언트가 인증서 불일치를 거부한다.

presigned URL 서명은 네트워크 요청 없이 로컬에서 수행한다.
컨테이너가 `STORIX_STORAGE_PUBLIC_ENDPOINT`에 접근하지 못해도 URL은 발급된다.

## 운영 배포로 옮길 때 바꿔야 하는 것

| 대상                                    | 운영 설정                    |
| --------------------------------------- | ---------------------------- |
| `ssl_certificate`·`ssl_certificate_key` | 실제 CA가 발급한 인증서 경로 |
| `server_name localhost;`                | 실제 공개 도메인             |
| `STORIX_STORAGE_PUBLIC_ENDPOINT`        | 실제 공개 도메인             |
| `STORIX_STORAGE_PUBLIC_PORT`            | 클라이언트가 접속하는 포트   |
| `STORIX_STORAGE_PUBLIC_USE_SSL`         | `true`                       |

- `nginx-cert-init`은 로컬 재현·통합 테스트 전용이다.
- 운영에서는 self-signed 생성 서비스를 사용하지 않는다.
- 서명 포트와 실제 접속 포트는 같아야 한다.
- 비표준 포트도 사용할 수 있다. 로컬 재현은 8443을 쓴다.
- 자동 통합 테스트는 testcontainers가 할당한 임의 포트로 검증한다.
- 표준 HTTPS 포트 443은 URL·Host 헤더에서 포트를 생략할 수 있다.

## 왜 `$http_host`이고 `$host`가 아닌가

- `$host`는 포트를 제거한다.
- 비표준 포트를 제거하면 VersityGW 서명 검증이 실패한다.
- `$http_host`는 클라이언트의 Host 헤더를 포트와 함께 보존한다.

## 메서드 제한

presigned URL은 GET으로 발급한다.
`nginx-reverse-proxy.conf`는 `limit_except GET`과 `deny all`로 메서드를 제한한다.
거부된 요청은 403이다.
