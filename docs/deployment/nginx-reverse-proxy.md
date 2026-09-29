# nginx reverse-proxy 참조 구성

STORAGE-03. "공개 도메인 → nginx → 내부 VersityGW" 배포 패턴의 참조 구성이다.
presigned download URL(STORAGE-02)은 발급 시점 Client의 host/port/scheme으로
서명되므로, TLS를 종료하는 리버스 프록시 뒤에 배포하려면 프록시가 원본 Host
헤더와 쿼리스트링을 그대로 VersityGW로 전달해야 서명이 깨지지 않는다. 결정 배경은
`../adr/0002-nginx-reverse-proxy-sample.md` 참고.

## 구성 파일

- `nginx-reverse-proxy.conf`(이 디렉터리) — nginx 설정. 로컬 재현과 운영 배포가
  같은 파일을 쓴다.
- `compose.nginx-demo.yml`(이 디렉터리) — 위 conf를 마운트하는 `nginx`와
  self-signed 인증서를 만드는 `nginx-cert-init` 서비스. 개발·검증용이며 Storix
  필수 구성이 아니라 루트 `docker-compose*` 목록에 두지 않는다.

이 샘플은 `proxy_pass http://versitygw:7070`으로 고정된 VersityGW 전용 구성이라
`docker-compose.versitygw.yml` 조합에서만 동작한다. 서명 검증 재현을 위해 `location /`의 GET을 VersityGW로 전달하므로, 운영에서 공개할 bucket 경로를 한정하는 설정 예시는 아니다. 운영 공개 listener는 실제 presigned URL의 bucket 경로만 라우팅하고, Storix 보호 API는 WAS 전용 내부 경로에 둔다. nginx의 GET 제한은 서명 검증을 대체하지 않으며 bucket은 비공개로 유지한다. 자세한 사용처 경계는 [WAS 다운로드 가이드](../guides/was-file-download-patterns.md)를 따른다.

## 로컬 재현 (docker-compose)

```bash
export STORIX_API_KEY=$(openssl rand -hex 32)
export STORIX_STORAGE_PUBLIC_ENDPOINT=localhost
export STORIX_STORAGE_PUBLIC_PORT=8443
export STORIX_STORAGE_PUBLIC_USE_SSL=true
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml \
  -f docs/deployment/compose.nginx-demo.yml up -d --wait
```

`nginx-cert-init` 서비스가 기동 시 self-signed 인증서를 생성하고(`nginx-certs`
볼륨), `nginx` 서비스(호스트 포트 `${STORIX_NGINX_PUBLIC_PORT:-8443}` → 컨테이너
443)가 이를 로드한다. 인증서 CN/SAN은 `localhost` 고정이다 — 다른 hostname으로
접속하면 TLS 클라이언트가 인증서 불일치로 거부한다. presigned URL 서명은 네트워크 요청
없이 로컬에서 이뤄지므로 컨테이너에서 `STORIX_STORAGE_PUBLIC_ENDPOINT`에 접근할 수 없어도
발급된다.

## 운영 배포로 옮길 때 바꿔야 하는 것

- `nginx-reverse-proxy.conf`의 `ssl_certificate`/`ssl_certificate_key`를 실제
  CA가 발급한 인증서로 교체한다. `nginx-cert-init`(self-signed 생성)은 로컬
  재현/통합 테스트 전용이며 운영에는 쓰지 않는다.
- `server_name localhost;`를 실제 공개 도메인으로 교체한다.
- `STORIX_STORAGE_PUBLIC_ENDPOINT`를 그 도메인으로, `STORIX_STORAGE_PUBLIC_PORT`를 클라이언트가
  실제로 접속하는 포트와 동일한 값으로, `STORIX_STORAGE_PUBLIC_USE_SSL=true`로 설정한다.
  규칙은 "서명에 쓰인 포트 = 클라이언트가 실제 접속하는 포트"가 전부다 — 위
  로컬 재현의 `8443`처럼 비표준 포트도 그 자체로는 문제없다(자동 통합
  테스트도 testcontainers가 할당한 임의 포트로 검증한다). 443을 권장하는 건
  정확성이 아니라 편의 때문이다: 표준 HTTPS 포트는 URL/Host 헤더에서
  생략되어 더 깔끔한 presigned URL이 나온다.

## 왜 `$http_host`이고 `$host`가 아닌가

nginx의 `$host`는 포트를 제거한 값이라, 비표준 포트(로컬 재현의 `8443`처럼)로
접속했을 때 그 포트 정보가 사라져 VersityGW가 서명 검증에 실패한다. `$http_host`는
클라이언트가 보낸 Host 헤더를 그대로 보존한다.

## 메서드 제한

presigned URL은 GET 전용이다. `nginx-reverse-proxy.conf`는 `limit_except GET`으로
그 외 메서드를 프록시 레벨에서 차단한다(403 — `limit_except`+`deny all`의 nginx
표준 동작).
