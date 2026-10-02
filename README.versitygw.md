# VersityGW 백엔드로 Storix 실행하기

VersityGW는 Storix의 목표 기본 스토리지 백엔드다(ADR-0003).
posix 백엔드로 로컬 디스크·NAS 마운트 경로를 S3 API에 노출한다.
Storix `app`은 `STORIX_STORAGE_*` 접속 정보로 연결한다.

이 문서는 `docker-compose.versitygw.yml` 조합의 설정·실행 절차다.
파일 배치 결정은 `docs/adr/0004-compose-file-layout.md`를 따른다.

## 언제 쓰는가

| 상황                | 구성                                                    |
| ------------------- | ------------------------------------------------------- |
| 신규 운영 환경      | VersityGW + Postgres                                    |
| NAS 기반 운영 환경  | WAS마다 VersityGW 1:1 배치 + 공유 Postgres              |
| 로컬 개발           | `docker-compose.postgres.yml` 추가                      |
| 기존 VersityGW 연결 | override 없이 base 사용(아래 "기존 VersityGW에 붙이기") |

멀티 인스턴스 운영 규칙:

- 각 WAS의 VersityGW는 같은 공유 NAS·DB에 연결한다.
- backup·restore는 전체 인스턴스 중 한 호스트에서만 실행한다.
- 호스트마다 실행하면 같은 데이터에 중복 작업한다.
- gc는 advisory lock으로 중복 실행을 막는다.
- 상세 구성은 `docs/deployment/multi-instance-versitygw.md`를 따른다.

## 사전 준비

- Docker Compose v2 또는 podman-compose.
- (선택) 호스트에 마운트된 NAS 경로(예: `/mnt/nas/storix-data`).
- NAS 경로가 없으면 named volume을 쓴다.

## .env 설정

```bash
cp .env.example .env
```

이 조합에서 실제로 읽히는 값:

| 변수                                                                                                 | 값                                      | 비고                                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `STORIX_API_KEY`                                                                                     | `openssl rand -hex 32` 출력             | 필수(미설정 시 compose 실패)                                                  |
| `STORIX_STORAGE_ACCESS_KEY` / `STORIX_STORAGE_SECRET_KEY`                                            | 임의 값                                 | app·VersityGW root 공용 자격증명(`ROOT_ACCESS_KEY`/`ROOT_SECRET_KEY`)         |
| `STORIX_STORAGE_BUCKET`                                                                              | 버킷 이름                               | `versitygw-init`이 기동 시 생성                                               |
| `STORIX_VERSITYGW_DATA_PATH`                                                                         | 비움 또는 `/`로 시작하는 절대 경로      | NAS 경로 또는 named volume `versitygw-data`(미설정 시)                        |
| `STORIX_DB_HOST` / `STORIX_DB_PORT` / `STORIX_DB_USERNAME` / `STORIX_DB_PASSWORD` / `STORIX_DB_NAME` | 외부 Postgres 접속 정보                 | `docker-compose.postgres.yml`을 겹치면 컨테이너 쪽은 `postgres:5432`로 재정의 |
| `STORIX_STORAGE_PUBLIC_ENDPOINT` / `STORIX_STORAGE_PUBLIC_PORT` / `STORIX_STORAGE_PUBLIC_USE_SSL`    | 클라이언트가 접근 가능한 VersityGW 주소 | presigned download 전용(미설정 시 해당 API만 실패)                            |
| `STORIX_STORAGE_REGION`                                                                              | 예: `us-east-1`                         | VersityGW `--region`과 같은 값(기본·compose: `us-east-1`)                     |

운영에서는 기본 자격증명을 교체한다.

override가 고정하는 값(`.env` 값은 무시한다):

| 변수                      | 고정값      |
| ------------------------- | ----------- |
| `STORIX_STORAGE_ENDPOINT` | `versitygw` |
| `STORIX_STORAGE_PORT`     | `7070`      |
| `STORIX_STORAGE_USE_SSL`  | `false`     |

## 기동

개발(로컬 Postgres 컨테이너 포함):

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml up -d --build
```

운영(외부 Postgres, `.env`의 `STORIX_DB_*` 사용):

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml up -d --build
```

기동 순서:

1. `versitygw` healthcheck.
2. `versitygw-init` 버킷 생성.
3. `migrate` 스키마 마이그레이션.
4. `app` 실행.

`docker compose ... ps`에서 `versitygw-init`·`migrate`의 `Exited (0)`은 정상 종료다.

`-f` 나열을 줄이려면 `.env`에 조합을 적는다.
docker compose 전용 설정이다.
podman-compose는 쉘에서 export한다:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.versitygw.yml:docker-compose.postgres.yml
```

Podman은 위 명령의 `docker compose`를 `podman-compose`로 바꾸면 된다.

### 기존 VersityGW에 붙이기

기존 VersityGW 연결 순서:

1. 버킷을 미리 만든다(base는 버킷을 생성하지 않는다).
2. `.env`에 접속 정보를 넣는다.
3. override 없이 base만 기동한다.

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
NS=$(curl -sf -X POST http://localhost:3000/api/v2/namespaces \
  -H "$AUTH" -H "Idempotency-Key: readme-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"readme-check","encryptionPolicy":"NONE"}' | jq -r '.id')

# 업로드 (parents=true: 중간 디렉터리 자동 생성)
curl -sf -X POST "http://localhost:3000/api/v2/namespaces/${NS}/fs/content?path=/docs/hello.txt&parents=true" \
  -H "$AUTH" -H 'Content-Type: text/plain' --data-binary 'hello versitygw'

# 다운로드
curl -sf "http://localhost:3000/api/v2/namespaces/${NS}/fs/content?path=/docs/hello.txt" -H "$AUTH"

# 디렉터리 목록
curl -sf "http://localhost:3000/api/v2/namespaces/${NS}/fs/ls?path=/docs" -H "$AUTH"
```

posix 백엔드에서 버킷은 디렉터리로 보인다.
오브젝트는 파일로 보인다.
컨테이너 안에서 직접 확인:

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml exec versitygw ls -R /data
```

### presigned download (선택)

presigned URL은 클라이언트가 직접 접근할 VersityGW 주소로 서명한다.
기본 조합은 `versitygw` 포트를 호스트에 노출하지 않는다.

로컬 확인 순서:

1. 호스트에 `versitygw` 포트를 노출한다.
2. `.env`에 공개 주소를 넣는다.

아래 내용을 `docker-compose.override.yml`로 저장하고(gitignore됨) 조합 끝에
`-f docker-compose.override.yml`을 추가한다:

```yaml
services:
  versitygw:
    ports:
      - "7070:7070"
```

```bash
# .env
STORIX_STORAGE_PUBLIC_ENDPOINT=localhost
STORIX_STORAGE_PUBLIC_PORT=7070
STORIX_STORAGE_PUBLIC_USE_SSL=false
```

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml \
  -f docker-compose.override.yml up -d
curl -sf "http://localhost:3000/api/v2/namespaces/${NS}/fs/presigned-download?path=/docs/hello.txt" \
  -H "$AUTH" | jq -r '.url' | xargs curl -sf
```

운영에서는 `STORIX_STORAGE_PUBLIC_*`에 클라이언트가 실제로 접속하는 공개 주소·포트·
scheme을 넣는다. TLS 종료 프록시 뒤에 둘 때의 규칙은
`docs/deployment/nginx-reverse-proxy.md` 참고.

## 운영 잡

배포에 쓴 `-f` 조합에 profile을 더한다.
절차·주의사항은 `docs/deployment/backup-restore.md`를 따른다.

`backup`·`restore`는 멀티 인스턴스(1:1 VersityGW + 공유 DB)에서 **한 호스트에서만** 실행한다.
모든 WAS 호스트는 같은 공유 NAS·DB에 연결한다.
호스트마다 실행하면 같은 데이터에 중복 작업한다.

`gc` 중복 실행 방지:

- Postgres advisory lock과 `STORIX_GC_MIN_INTERVAL`(기본 3600초)을 사용한다.
- 다른 인스턴스가 실행 중이면 건너뛴다.
- 마지막 완료 후 `STORIX_GC_MIN_INTERVAL` 이내이면 건너뛴다.
- 모든 WAS 호스트에 같은 스케줄(예: cron)을 등록할 수 있다.
- 스캔·삭제는 한 인스턴스만 수행한다.

```bash
C="-f docker-compose.yml -f docker-compose.versitygw.yml"   # 개발이면 -f docker-compose.postgres.yml 추가

docker compose $C --profile gc run --rm gc
docker compose $C --profile backup run --rm backup
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose $C --profile restore run --rm restore
```

## 특이사항·문제 해결

- **`STORIX_VERSITYGW_DATA_PATH`는 절대 경로여야 한다.** `/` 없이 쓰면 Docker Compose가
  named volume 이름으로 해석한다.
  데이터는 NAS 대신 로컬 볼륨에 기록한다.
- **멀티 인스턴스(공유 DB + NAS)**: 모든 WAS 호스트가 같은 `STORIX_VERSITYGW_DATA_PATH`와
  같은 `STORIX_DB_HOST`를 쓴다.
  `docker-compose.postgres.yml`은 겹치지 않는다.
  여러 VersityGW가 같은 NAS를 동시에 쓰는 posix 구성의 안전성은 검증되지 않았다.
  상세 구성은 `docs/deployment/multi-instance-versitygw.md`를 따른다.
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
