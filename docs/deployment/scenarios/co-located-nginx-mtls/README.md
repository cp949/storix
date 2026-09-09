# 기존 Nginx의 내부 mTLS listener를 사용하는 배포

이 문서는 여러 배포 시나리오 중 하나다. Storix의 표준 배포 방법을 정의하지
않는다. 단일 개발 서버도 운영과 같은 요청 경계를 사용하면서, 현재 가용한 2개
운영 서버에 Nginx·WAS·Storix·VersityGW를 함께 배치해야 할 때 적용한다.

## 적용 조건

- 개발 서버는 1대이며 기존 Nginx, WAS, Storix, VersityGW가 함께 실행된다.
- 개발 Storix DB는 SQLite 또는 PostgreSQL 중 선택한다.
- 운영 서버는 A/B 2대이며 각 서버에 기존 Nginx, WAS, Storix, VersityGW가
  하나씩 실행된다.
- 운영 Storix A/B는 하나의 PostgreSQL을 공유한다.
- VersityGW A/B는 동일한 NAS 경로를 POSIX backend로 사용한다.
- 두 VersityGW가 NAS를 동시에 사용할 때의 락·캐시·rename·장애 의미는 해당
  POSIX/NAS가 제공하는 수준으로 수용한다.
- 회사 L7 LB에 내부 mTLS 인증서나 Client CA를 배포하지 않는다.

다중 Storix 프로세스가 하나의 SQLite 파일을 공유해야 하거나, VersityGW A/B가
서로 다른 로컬 디스크를 사용하는 환경에는 적용하지 않는다.

## 토폴로지

### 개발

```text
개발 호스트
├─ 기존 Nginx
│  ├─ public listener ──────────────> WAS / VersityGW
│  └─ storix.internal:9443 (mTLS) ─> Storix:3000
├─ WAS
├─ Storix ─> SQLite 또는 PostgreSQL
└─ VersityGW ─> 개발 볼륨 또는 NAS
```

### 운영

```text
                       ┌─ Nginx A ─ WAS A
외부 요청 ─ 회사 L7 LB ┤          ├ Storix A ─ VersityGW A ─┐
                       └─ Nginx B ─ WAS B                    ├─ 동일 NAS
                                  ├ Storix B ─ VersityGW B ─┘
                                  └──────────────┬───────────
                                           PostgreSQL

내부 요청: WAS A → Nginx A:9443 → Storix A
           WAS B → Nginx B:9443 → Storix B
```

회사 L7 LB는 외부 요청만 처리한다. WAS가 Storix를 호출하는 mTLS 연결은 각
호스트의 private listener에서 종료되므로 LB는 내부 서버 인증서, WAS Client CA,
WAS 인증서를 소유하지 않는다.

## 신뢰 경계

| 구간 | 보호 수단 | 비고 |
| --- | --- | --- |
| 외부 → 회사 LB/Nginx | 회사의 공개 TLS 정책 | 이 시나리오의 mTLS 범위 밖 |
| WAS → 기존 Nginx `:9443` | mTLS | Nginx가 WAS 인증서를 검증 |
| Nginx → Storix `127.0.0.1:3000` | loopback + Storix API key | Nginx는 API key를 주입하지 않음 |
| Storix → VersityGW | 호스트 내부 연결 + S3 SigV4 | 운영 데이터는 공통 NAS에 저장 |
| Storix A/B → PostgreSQL | DB TLS·계정 정책 | WAS 업무 DB와 별도 DB/user 권장 |

Storix의 기존 `Authorization: Bearer <STORIX_API_KEY>` 검증은 mTLS 뒤에서도
유지한다. mTLS는 호출 머신을 인증하고 API key는 Storix 애플리케이션 경계를 한
번 더 보호한다.

## 포함 파일

- [`nginx/storix-internal-mtls.conf`](nginx/storix-internal-mtls.conf): 기존
  Nginx `http` context에서 로드할 내부 전용 server block
- [`nginx/presigned-log-format.conf`](nginx/presigned-log-format.conf): 기존
  Nginx `http` context에서 로드할 query-free 로그 형식
- [`nginx/storage-public.location.conf`](nginx/storage-public.location.conf):
  기존 공개 `sample.com` server block에서 include할 `/storage/` location
- [`compose.host-nginx.yml`](compose.host-nginx.yml): 호스트 Nginx가 로컬
  VersityGW에 접근하도록 loopback port를 추가하는 공통 override
- [`env/development.env.example`](env/development.env.example): 개발 설정 예시
- [`env/production.env.example`](env/production.env.example): 운영 노드 공통
  설정 예시
- [`pki/generate-development-certificates.sh`](pki/generate-development-certificates.sh):
  개발 전용 CA·server·client 인증서 생성기

별도 Nginx 컨테이너는 추가하지 않는다. 설정 파일은 각 호스트에 이미 설치된
Nginx가 읽는다.

## Nginx 설치

다음 경로는 예시다. 배포 자동화에서 동일한 include 관계를 유지하되 운영체제의
Nginx 경로에 맞게 조정한다.

```nginx
# nginx.conf의 http { ... } 안
include /etc/nginx/storix/presigned-log-format.conf;
include /etc/nginx/storix/storix-internal-mtls.conf;

server {
    # 회사 L7 LB → 기존 Nginx listener/TLS 설정은 현재 운영 구성을 유지한다.
    server_name sample.com;

    # 기존 /was/ 설정과 함께 추가한다.
    include /etc/nginx/storix/storage-public.location.conf;
}
```

내부 listener의 `storix.internal:9443`은 private network에서만 접근을 허용한다.
운영에서는 방화벽으로 9443의 출발지를 WAS A/B로 제한한다.

공개 `/storage/`는 path-style S3 URL의 bucket 부분이다. 따라서 이 시나리오는
`STORIX_STORAGE_BUCKET=storage`를 요구한다. Nginx가 `/storage/`를 제거하거나
Host·query string을 변경하면 presigned SigV4 검증이 실패한다.
회사 L7 LB도 원래 Host, `/storage/` path, query string을 보존해야 한다.

## 개발 환경

### 1. 인증서 생성

```bash
docs/deployment/scenarios/co-located-nginx-mtls/pki/generate-development-certificates.sh
```

생성된 `docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/`는
gitignore 대상이다. 다음 파일을 개발 Nginx가 기대하는 경로에 설치한다.

```text
pki/generated/ca.crt          → /etc/nginx/storix-mtls/ca.crt
pki/generated/server.crt      → /etc/nginx/storix-mtls/server.crt
pki/generated/server.key      → /etc/nginx/storix-mtls/server.key
```

WAS에는 다음 파일만 배포한다.

```text
pki/generated/ca.crt
pki/generated/was-client.crt
pki/generated/was-client.key
```

개발 호스트에서 `storix.internal`이 `127.0.0.1` 또는 그 호스트의 private IP로
해석되게 한다. 인증서 SAN이 `storix.internal`이므로 IP URL 대신 이 이름을 쓴다.
`sample.com`도 개발 Nginx를 가리키게 하거나 개발 환경에 맞는 공개 hostname으로
환경값과 기존 Nginx 설정을 함께 바꾼다.

### 2. SQLite로 기동

```bash
docker compose \
  --env-file docs/deployment/scenarios/co-located-nginx-mtls/env/development.env.example \
  -f docker-compose.yml \
  -f docker-compose.versitygw.yml \
  -f docker-compose.sqlite.yml \
  -f docs/deployment/scenarios/co-located-nginx-mtls/compose.host-nginx.yml \
  up -d --build
```

개발에서 PostgreSQL을 선택하려면 `docker-compose.sqlite.yml` 대신
`docker-compose.postgres.yml`을 사용한다. 시나리오 override와 Nginx 설정은
바뀌지 않는다.

## 운영 환경

운영 A/B 노드에는 환경별 비밀값을 채운 별도 `.env`를 배포한다. 저장소의
`production.env.example`을 비밀값 파일로 직접 사용하지 않는다.

```bash
docker compose \
  --env-file /etc/storix/storix.env \
  -f docker-compose.yml \
  -f docker-compose.versitygw.yml \
  -f docs/deployment/scenarios/co-located-nginx-mtls/compose.host-nginx.yml \
  up -d --build
```

A/B의 다음 값은 동일해야 한다.

- PostgreSQL host, port, database, user
- `STORIX_STORAGE_ACCESS_KEY`, `STORIX_STORAGE_SECRET_KEY`, bucket, region
- `STORIX_VERSITYGW_DATA_PATH`가 가리키는 NAS mount path
- `STORIX_API_KEY`와 암호화 namespace를 쓸 때의 master key
- 공개 presigned endpoint, port, scheme

SQLite는 이 운영 구성에서 사용하지 않는다. `gc`, `backup`, `restore` 실행 규칙은
루트 배포 문서를 따른다. 특히 SQLite와 PostgreSQL의 백업 형식은 서로 호환되지
않는다.

## 검증

Nginx 설정을 반영하기 전에 문법을 검사한다.

```bash
sudo nginx -t
sudo nginx -s reload
```

Client 인증서 없이 내부 listener에 접근하면 TLS handshake 또는 Nginx의 인증서
검사 단계에서 요청이 실패해야 한다.

```bash
curl --cacert docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/ca.crt \
  --resolve storix.internal:9443:127.0.0.1 \
  https://storix.internal:9443/health/live
```

신뢰된 WAS 인증서를 제시하면 성공해야 한다.

```bash
curl --cacert docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/ca.crt \
  --cert docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/was-client.crt \
  --key docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/was-client.key \
  --resolve storix.internal:9443:127.0.0.1 \
  https://storix.internal:9443/health/live
```

Storix 보호 API에는 mTLS와 API key를 함께 보낸다.

```bash
export STORIX_API_KEY='development-only-api-key-change-before-production'
curl --cacert docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/ca.crt \
  --cert docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/was-client.crt \
  --key docs/deployment/scenarios/co-located-nginx-mtls/pki/generated/was-client.key \
  --resolve storix.internal:9443:127.0.0.1 \
  -H "Authorization: Bearer ${STORIX_API_KEY}" \
  https://storix.internal:9443/api/v1/namespaces
```

## 장애 및 확장

- 노드 A 전체 장애 시 회사 LB가 외부 요청을 B로 보내고, WAS B는 같은 호스트의
  Nginx B·Storix B·VersityGW B를 사용한다.
- Storix 프로세스만 장애가 나면 같은 호스트의 Nginx는 502를 반환한다. 먼저
  컨테이너 재시작 정책으로 복구하고, 필요할 때 반대편 Storix를 backup upstream으로
  추가한다.
- PostgreSQL 1대와 NAS는 이 시나리오에서 공유 장애 지점이다. 각각 별도 백업과
  장애 복구 절차가 필요하다.
- 향후 Storix 전용 호스트를 확보하면 WAS의 `storix.internal` DNS와 Nginx upstream만
  전용 호스트로 옮긴다. WAS 코드와 Storix API 계약은 변경하지 않는다.

## 알려진 제약

- 동일 NAS를 사용하는 두 VersityGW의 동시 접근은 NAS가 제공하는 POSIX 의미를
  그대로 따른다. Storix가 그 위에 별도 분산 락을 추가하지 않는다.
- mTLS 인증서 회전과 폐기는 운영 PKI 정책의 책임이다.
- 현재 자동 Nginx reverse-proxy 통합 테스트는 MinIO를 사용한다. 운영 도입 전에
  이 시나리오의 VersityGW·NAS 조합으로 PUT 직후 반대 노드 GET, 동시 PUT,
  multipart upload, DELETE/GET·GC 경합을 별도로 확인한다.
