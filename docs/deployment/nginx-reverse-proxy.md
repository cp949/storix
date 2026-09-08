# nginx reverse-proxy 참조 구성

STORAGE-03. "공개 도메인 → nginx → 내부 MinIO" 배포 패턴의 참조 구성이다.
presigned download URL(STORAGE-02)은 발급 시점 Client의 host/port/scheme으로
서명되므로, TLS를 종료하는 리버스 프록시 뒤에 배포하려면 프록시가 원본 Host
헤더와 쿼리스트링을 그대로 MinIO로 전달해야 서명이 깨지지 않는다. 결정 배경은
`../adr/0002-nginx-reverse-proxy-sample.md` 참고.

## 구성 파일

`nginx-reverse-proxy.conf`(이 디렉터리) — `docker-compose.minio.yml`의 `nginx`
서비스(`nginx-demo` profile)가 그대로 마운트한다. 로컬 재현과 운영 배포가 같은
파일을 쓴다.

이 샘플은 `proxy_pass http://minio:9000`으로 고정된 MinIO 전용 구성이라
`docker-compose.minio.yml`에 들어 있다. VersityGW 앞에 두려면 upstream을
`versitygw:7070`으로 바꾼 conf 사본이 필요하다 — 샘플의 백엔드 중립화는
후속 작업이다.

## 로컬 재현 (docker-compose)

```bash
export API_KEY=$(openssl rand -hex 32)
export STORAGE_PUBLIC_ENDPOINT=localhost
export STORAGE_PUBLIC_PORT=8443
export STORAGE_PUBLIC_USE_SSL=true
export STORAGE_REGION=us-east-1
docker compose -f docker-compose.yml -f docker-compose.minio.yml -f docker-compose.postgres.yml \
  --profile nginx-demo up -d --wait
```

`nginx-cert-init` 서비스가 기동 시 self-signed 인증서를 생성하고(`nginx-certs`
볼륨), `nginx` 서비스(호스트 포트 `${NGINX_PUBLIC_PORT:-8443}` → 컨테이너
443)가 이를 로드한다. 인증서 CN/SAN은 `localhost` 고정이다 — 다른 hostname으로
접속하면 TLS 클라이언트가 인증서 불일치로 거부한다. `STORAGE_REGION`을 비워두면
minio-js가 리전 자동 조회를 위해 `STORAGE_PUBLIC_ENDPOINT`(컨테이너 자기 자신의
loopback으로 되돌아가는 주소)에 실제 네트워크 호출을 시도하다 실패해
presigned-download 발급이 500나므로, `STORAGE_REGION`을 설정해 이 호출 자체를
스킵해야 한다.

## 운영 배포로 옮길 때 바꿔야 하는 것

- `nginx-reverse-proxy.conf`의 `ssl_certificate`/`ssl_certificate_key`를 실제
  CA가 발급한 인증서로 교체한다. `nginx-cert-init`(self-signed 생성)은 로컬
  재현/통합 테스트 전용이며 운영에는 쓰지 않는다.
- `server_name localhost;`를 실제 공개 도메인으로 교체한다.
- `STORAGE_PUBLIC_ENDPOINT`를 그 도메인으로, `STORAGE_PUBLIC_PORT`를 클라이언트가
  실제로 접속하는 포트와 동일한 값으로, `STORAGE_PUBLIC_USE_SSL=true`로 설정한다.
  규칙은 "서명에 쓰인 포트 = 클라이언트가 실제 접속하는 포트"가 전부다 — 위
  로컬 재현의 `8443`처럼 비표준 포트도 그 자체로는 문제없다(자동 통합
  테스트도 testcontainers가 할당한 임의 포트로 검증한다). 443을 권장하는 건
  정확성이 아니라 편의 때문이다: 표준 HTTPS 포트는 URL/Host 헤더에서
  생략되어 더 깔끔한 presigned URL이 나온다.
- `STORAGE_REGION`을 비워두지 않는다 — presigned URL 발급마다 리전 자동 조회가
  공개 프록시로 실제 네트워크 왕복을 시도한다(방화벽·split-horizon DNS
  환경에서는 로컬 재현과 동일하게 500날 수 있다). 값 자체는 MinIO 서버
  설정과만 맞으면 되고, 기본 `us-east-1`이면 충분하다.

## 왜 `$http_host`이고 `$host`가 아닌가

nginx의 `$host`는 포트를 제거한 값이라, 비표준 포트(로컬 재현의 `8443`처럼)로
접속했을 때 그 포트 정보가 사라져 MinIO가 서명 검증에 실패한다. `$http_host`는
클라이언트가 보낸 Host 헤더를 그대로 보존한다.

## 메서드 제한

presigned URL은 GET 전용이다. `nginx-reverse-proxy.conf`는 `limit_except GET`으로
그 외 메서드를 프록시 레벨에서 차단한다(403 — `limit_except`+`deny all`의 nginx
표준 동작).
