# VersityGW 백엔드로 Storix 실행하기

VersityGW는 Storix의 목표 기본 스토리지 백엔드다
(`docs/adr/0003-versitygw-primary-backend-and-topology.md`). posix 백엔드로 로컬
디스크나 NAS 마운트 경로를 S3 API로 노출하고, Storix `app`은 `STORIX_STORAGE_*` 접속
정보만으로 붙는다. 이 문서는 `docker-compose.versitygw.yml` 조합을 처음부터
끝까지 따라가는 절차다. 파일 배치 배경은 `docs/adr/0004-compose-file-layout.md`.

## 언제 쓰는가

- 새로 구축하는 운영 환경. NAS 기반이면 WAS마다 VersityGW를 1:1로 붙이고
  Postgres는 공유한다(`docs/deployment/multi-instance-versitygw.md`).
- 로컬 개발. 운영과 같은 백엔드로 개발하려면 이 조합에
  `docker-compose.postgres.yml`을 더한다.
- 이미 운영 중인 VersityGW가 있으면 이 override 없이 base만 쓴다(아래 "기존
  VersityGW에 붙이기").

## 사전 준비

- Docker Compose v2 또는 podman-compose.
- (선택) NAS 마운트 경로. 호스트에 이미 마운트돼 있어야 한다(예:
  `/mnt/nas/storix-data`). 없으면 named volume을 쓴다.

## .env 설정

```bash
cp .env.example .env
```

이 조합에서 실제로 읽히는 값:

| 변수 | 값 | 비고 |
|---|---|---|
| `STORIX_API_KEY` | `openssl rand -hex 32` 출력 | 필수. 비어 있으면 compose가 즉시 실패 |
| `STORIX_STORAGE_ACCESS_KEY` / `STORIX_STORAGE_SECRET_KEY` | 임의 값 | app 접속 자격증명이자 VersityGW root 자격증명(`ROOT_ACCESS_KEY`/`ROOT_SECRET_KEY`). 운영에서는 기본값을 교체 |
| `STORIX_STORAGE_BUCKET` | 버킷 이름 | `versitygw-init`이 기동 시 생성 |
| `STORIX_VERSITYGW_DATA_PATH` | 비움 또는 `/`로 시작하는 절대 경로 | 비우면 named volume `versitygw-data`. NAS면 절대 경로 |
| `STORIX_DB_HOST` / `STORIX_DB_PORT` / `STORIX_DB_USERNAME` / `STORIX_DB_PASSWORD` / `STORIX_DB_NAME` | 외부 Postgres 접속 정보 | `docker-compose.postgres.yml`을 겹치면 컨테이너 쪽은 `postgres:5432`로 재정의 |
| `STORIX_STORAGE_PUBLIC_ENDPOINT` / `STORIX_STORAGE_PUBLIC_PORT` / `STORIX_STORAGE_PUBLIC_USE_SSL` | 클라이언트가 접근 가능한 VersityGW 주소 | presigned download를 쓸 때만. 비우면 그 API만 실패 |
| `STORIX_STORAGE_REGION` | 예: `us-east-1` | presigned download를 쓸 때 비우면 안 됨(아래 문제 해결) |

override가 덮어써서 무시되는 값: `STORIX_STORAGE_ENDPOINT` / `STORIX_STORAGE_PORT` /
`STORIX_STORAGE_USE_SSL`(`versitygw` / `7070` / `false`로 고정).

## 기동

개발(로컬 Postgres 컨테이너 포함):

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml up -d --build
```

운영(외부 Postgres, `.env`의 `STORIX_DB_*` 사용):

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml up -d --build
```

기동 순서: `versitygw`(healthcheck) → `versitygw-init`(버킷 생성) →
`migrate`(스키마) → `app`. `docker compose ... ps`에서 `versitygw-init`과
`migrate`는 `Exited (0)`이 정상이다.

매번 `-f`를 나열하지 않으려면 `.env`에 조합을 적는다(docker compose 전용,
podman-compose는 쉘에서 export):

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.versitygw.yml:docker-compose.postgres.yml
```

Podman은 위 명령의 `docker compose`를 `podman-compose`로 바꾸면 된다.

### 기존 VersityGW에 붙이기

이미 운영 중인 VersityGW가 있으면 override 없이 base만 기동하고 `.env`에 접속
정보를 넣는다. base는 버킷을 만들지 않으므로 버킷은 미리 만들어 둔다.

```bash
STORIX_STORAGE_ENDPOINT=gw.internal.example
STORIX_STORAGE_PORT=7070
STORIX_STORAGE_USE_SSL=false
STORIX_STORAGE_PATH_STYLE=true
STORIX_STORAGE_ACCESS_KEY=<발급받은 access key>
STORIX_STORAGE_SECRET_KEY=<발급받은 secret key>
STORIX_STORAGE_BUCKET=storix
```

```bash
docker compose up -d --build
```

## 동작 확인

```bash
STORIX_API_KEY=$(grep '^STORIX_API_KEY=' .env | cut -d= -f2-)
AUTH="Authorization: Bearer ${STORIX_API_KEY}"

# app 준비 대기
until curl -sf http://localhost:3000/health/ready > /dev/null; do sleep 2; done

# namespace 생성 (Idempotency-Key 헤더 필수)
NS=$(curl -sf -X POST http://localhost:3000/api/v1/namespaces \
  -H "$AUTH" -H "Idempotency-Key: readme-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"readme-check","encryptionPolicy":"NONE"}' | jq -r '.id')

# 업로드 (parents=true: 중간 디렉터리 자동 생성)
curl -sf -X PUT "http://localhost:3000/api/v1/namespaces/${NS}/fs/content?path=docs/hello.txt&parents=true" \
  -H "$AUTH" -H 'Content-Type: text/plain' --data-binary 'hello versitygw'

# 다운로드
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/content?path=docs/hello.txt" -H "$AUTH"

# 디렉터리 목록
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/ls?path=docs" -H "$AUTH"
```

VersityGW는 posix 백엔드라 버킷이 디렉터리, 오브젝트가 파일로 보인다.
컨테이너 안에서 직접 확인:

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml exec versitygw ls -R /data
```

### presigned download (선택)

presigned URL은 클라이언트가 VersityGW에 직접 접근하는 주소로 서명된다. 기본
조합은 `versitygw` 포트를 호스트에 노출하지 않으므로, 로컬에서 확인하려면 포트를
노출하고 `.env`에 공개 주소를 넣는다.

아래 내용을 `docker-compose.override.yml`로 저장하고(gitignore됨) 조합 끝에
`-f docker-compose.override.yml`을 추가한다:

```yaml
services:
  versitygw:
    ports:
      - '7070:7070'
```

```bash
# .env
STORIX_STORAGE_PUBLIC_ENDPOINT=localhost
STORIX_STORAGE_PUBLIC_PORT=7070
STORIX_STORAGE_PUBLIC_USE_SSL=false
STORIX_STORAGE_REGION=us-east-1
```

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml \
  -f docker-compose.override.yml up -d
curl -sf "http://localhost:3000/api/v1/namespaces/${NS}/fs/presigned-download?path=docs/hello.txt" \
  -H "$AUTH" | jq -r '.url' | xargs curl -sf
```

운영에서는 `STORIX_STORAGE_PUBLIC_*`에 클라이언트가 실제로 접속하는 공개 주소·포트·
scheme을 넣는다. TLS 종료 프록시 뒤에 둘 때의 규칙은
`docs/deployment/nginx-reverse-proxy.md` 참고.

## 운영 잡

배포에 쓴 것과 같은 `-f` 조합에 profile을 더한다. 절차와 주의사항은
`docs/deployment/backup-restore.md`.

```bash
C="-f docker-compose.yml -f docker-compose.versitygw.yml"   # 개발이면 -f docker-compose.postgres.yml 추가

docker compose $C --profile gc run --rm gc
docker compose $C --profile backup run --rm backup
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose $C --profile restore run --rm restore
```

## 특이사항·문제 해결

- **`STORIX_VERSITYGW_DATA_PATH`는 절대 경로여야 한다.** `/` 없이 쓰면 Docker Compose가
  bind mount가 아니라 named volume 이름으로 조용히 해석해 NAS가 아닌 로컬
  볼륨에 쓴다.
- **멀티 인스턴스(공유 DB + NAS)**: 모든 WAS 호스트가 같은 `STORIX_VERSITYGW_DATA_PATH`와
  같은 `STORIX_DB_HOST`를 쓴다. `docker-compose.postgres.yml`은 겹치지 않는다. 여러
  VersityGW가 같은 NAS를 동시에 posix 백엔드로 쓰는 구성의 안전성은 아직
  검증되지 않았다. 상세: `docs/deployment/multi-instance-versitygw.md`.
- **presigned-download가 500**: `STORIX_STORAGE_REGION`이 비어 있으면 minio-js가 리전
  자동 조회를 위해 `STORIX_STORAGE_PUBLIC_ENDPOINT`로 실제 요청을 보내는데, 컨테이너
  안에서 `localhost`는 app 자기 자신이라 실패한다. `STORIX_STORAGE_REGION=us-east-1`
  (VersityGW 기본 리전)을 설정한다.
- **로그**: `docker compose $C logs -f app versitygw`.
- **데이터 초기화**:

  ```bash
  docker compose $C down -v
  ```

  ```txt
  위험도: 높음
  롤백: 불가능 — named volume(versitygw-data, postgres-data)이 삭제된다.
  STORIX_VERSITYGW_DATA_PATH로 bind mount한 NAS 경로는 삭제되지 않는다.
  ```
