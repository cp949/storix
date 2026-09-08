# MinIO 백엔드로 Storix 실행하기

MinIO는 Storix가 초기 개발 편의상 먼저 붙인 S3 호환 백엔드다. 목표 기본
백엔드는 VersityGW이고(`docs/adr/0003-versitygw-primary-backend-and-topology.md`),
MinIO 지원은 `STORAGE_*` 벤더 중립 추상화 덕에 따라오는 결과다. 이 문서는
`docker-compose.minio.yml` 조합을 처음부터 끝까지 따라가는 절차다. 파일 배치
배경은 `docs/adr/0004-compose-file-layout.md`.

## 언제 쓰는가

- 로컬 개발·검증. 단일 바이너리라 가볍고, 개발·검증용 nginx reverse-proxy
  샘플(`docs/deployment/compose.nginx-demo.yml`)이 이 조합을 전제한다.
- 이미 MinIO를 운영 중인 환경. 이 경우 override 없이 base만 쓴다(아래 "기존
  MinIO에 붙이기").

## 사전 준비

- Docker Compose v2 또는 podman-compose.

## .env 설정

```bash
cp .env.example .env
```

이 조합에서 실제로 읽히는 값:

| 변수 | 값 | 비고 |
|---|---|---|
| `API_KEY` | `openssl rand -hex 32` 출력 | 필수. 비어 있으면 compose가 즉시 실패 |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | 임의 값 | app 접속 자격증명이자 MinIO root 자격증명(`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`). MinIO 제약: user 3자 이상, password 8자 이상 |
| `STORAGE_BUCKET` | 버킷 이름 | `minio-init`이 기동 시 생성 |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_NAME` | 외부 Postgres 접속 정보 | `docker-compose.postgres.yml`을 겹치면 컨테이너 쪽은 `postgres:5432`로 재정의 |
| `STORAGE_PUBLIC_ENDPOINT` / `STORAGE_PUBLIC_PORT` / `STORAGE_PUBLIC_USE_SSL` | 클라이언트가 접근 가능한 MinIO 주소 | presigned download를 쓸 때만. 비우면 그 API만 실패 |
| `STORAGE_REGION` | 예: `us-east-1` | presigned download를 쓸 때 비우면 안 됨(아래 문제 해결) |

override가 덮어써서 무시되는 값: `STORAGE_ENDPOINT` / `STORAGE_PORT` /
`STORAGE_USE_SSL`(`minio` / `9000` / `false`로 고정).

## 기동

개발(로컬 Postgres 컨테이너 포함):

```bash
docker compose -f docker-compose.yml -f docker-compose.minio.yml -f docker-compose.postgres.yml up -d --build
```

운영(외부 Postgres, `.env`의 `DB_*` 사용):

```bash
docker compose -f docker-compose.yml -f docker-compose.minio.yml up -d --build
```

기동 순서: `minio`(healthcheck) → `minio-init`(버킷 생성) → `migrate`(스키마) →
`app`. `docker compose ... ps`에서 `minio-init`과 `migrate`는 `Exited (0)`이
정상이다.

매번 `-f`를 나열하지 않으려면 `.env`에 조합을 적는다(docker compose 전용,
podman-compose는 쉘에서 export):

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.minio.yml:docker-compose.postgres.yml
```

Podman은 위 명령의 `docker compose`를 `podman-compose`로 바꾸면 된다.

### 기존 MinIO에 붙이기

이미 운영 중인 MinIO가 있으면 override 없이 base만 기동하고 `.env`에 접속
정보를 넣는다. base는 버킷을 만들지 않으므로 버킷은 미리 만들어 둔다.

```bash
STORAGE_ENDPOINT=minio.internal.example
STORAGE_PORT=9000
STORAGE_USE_SSL=false          # TLS를 쓰는 서버면 true
STORAGE_PATH_STYLE=true
STORAGE_ACCESS_KEY=<발급받은 access key>
STORAGE_SECRET_KEY=<발급받은 secret key>
STORAGE_BUCKET=storix
```

```bash
docker compose up -d --build
```

## 동작 확인

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2-)
AUTH="Authorization: Bearer ${API_KEY}"

# app 준비 대기
until curl -sf http://localhost:3000/health/ready > /dev/null; do sleep 2; done

# namespace 생성 (Idempotency-Key 헤더 필수)
NS=$(curl -sf -X POST http://localhost:3000/api/v1/namespaces \
  -H "$AUTH" -H "Idempotency-Key: readme-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"readme-check","encryptionPolicy":"NONE"}' | jq -r '.id')

# 업로드 (parents=true: 중간 디렉터리 자동 생성)
curl -sf -X PUT "http://localhost:3000/api/v1/namespaces/${NS}/fs/content?path=docs/hello.txt&parents=true" \
  -H "$AUTH" -H 'Content-Type: text/plain' --data-binary 'hello minio'

# 다운로드
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/content?path=docs/hello.txt" -H "$AUTH"

# 디렉터리 목록
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/ls?path=docs" -H "$AUTH"
```

버킷 안의 실제 오브젝트 확인. `minio` 이미지에는 `mc`가 없으므로 `minio-init`
서비스(`minio/mc` 이미지, entrypoint `sh -c`)를 일회성으로 빌려 쓴다:

```bash
C="-f docker-compose.yml -f docker-compose.minio.yml"
AK=$(grep '^STORAGE_ACCESS_KEY=' .env | cut -d= -f2-)
SK=$(grep '^STORAGE_SECRET_KEY=' .env | cut -d= -f2-)
BK=$(grep '^STORAGE_BUCKET=' .env | cut -d= -f2-)
docker compose $C run --rm minio-init \
  "mc alias set local http://minio:9000 $AK $SK >/dev/null && mc ls -r local/$BK"
```

`minio-init` 컨테이너 환경에는 `STORAGE_*`가 없으므로 값은 호스트 쪽에서
`.env`를 읽어 명령 문자열에 넣는다.

### presigned download (선택)

presigned URL은 클라이언트가 MinIO에 직접 접근하는 주소로 서명된다. 기본
조합은 `minio` 포트를 호스트에 노출하지 않으므로, 로컬에서 확인하려면 포트를
노출하고 `.env`에 공개 주소를 넣는다.

아래 내용을 `docker-compose.override.yml`로 저장하고(gitignore됨) 조합 끝에
`-f docker-compose.override.yml`을 추가한다. `9001`은 MinIO 웹 콘솔이며 필요할
때만 연다:

```yaml
services:
  minio:
    ports:
      - '9000:9000'
      - '9001:9001'
```

```bash
# .env
STORAGE_PUBLIC_ENDPOINT=localhost
STORAGE_PUBLIC_PORT=9000
STORAGE_PUBLIC_USE_SSL=false
STORAGE_REGION=us-east-1
```

```bash
docker compose -f docker-compose.yml -f docker-compose.minio.yml -f docker-compose.postgres.yml \
  -f docker-compose.override.yml up -d
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/presigned-download?path=docs/hello.txt" \
  -H "$AUTH" | jq -r '.url' | xargs curl -sf
```

TLS 종료 프록시(공개 도메인 443 → nginx → MinIO 9000) 뒤에서 presigned 서명이
깨지지 않는지 재현하려면 `docs/deployment/compose.nginx-demo.yml`을 겹친다.
절차는 `docs/deployment/nginx-reverse-proxy.md`.

## 운영 잡

배포에 쓴 것과 같은 `-f` 조합에 profile을 더한다. 절차와 주의사항은
`docs/deployment/backup-restore.md`.

```bash
C="-f docker-compose.yml -f docker-compose.minio.yml"   # 개발이면 -f docker-compose.postgres.yml 추가

docker compose $C --profile gc run --rm gc
docker compose $C --profile backup run --rm backup
RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose $C --profile restore run --rm restore
```

## 특이사항·문제 해결

- **`minio` 컨테이너가 바로 종료**: `STORAGE_ACCESS_KEY`가 3자 미만이거나
  `STORAGE_SECRET_KEY`가 8자 미만이면 MinIO가 root 자격증명을 거부한다.
  `docker compose $C logs minio`로 확인.
- **presigned-download가 500**: `STORAGE_REGION`이 비어 있으면 minio-js가 리전
  자동 조회를 위해 `STORAGE_PUBLIC_ENDPOINT`로 실제 요청을 보내는데, 컨테이너
  안에서 `localhost`는 app 자기 자신이라 실패한다. `STORAGE_REGION=us-east-1`
  (MinIO 기본 리전)을 설정한다.
- **로그**: `docker compose $C logs -f app minio`.
- **데이터 초기화**:

  ```bash
  docker compose $C down -v
  ```

  ```txt
  위험도: 높음
  롤백: 불가능 — named volume(minio-data, postgres-data)이 삭제된다.
  ```
