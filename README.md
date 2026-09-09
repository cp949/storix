# Storix

Storix는 호출 서버가 사용하는 독립 VFS(Virtual File System) 저장 서버다.
파일의 업무적 의미와 최종 사용자 인증·권한 판단은 호출 서버의 책임이며 Storix
도메인에 포함하지 않는다.

## 핵심 기능

### 파일시스템식 API

Storage key나 object ID가 아니라 경로(path) 기준으로 동작한다.

- `mkdir`, `touch`, `mv`, `cp`, `rmdir`, `rm` — 디렉터리/파일 조작
- `POST`/`GET content`, `GET download` — 콘텐츠 업로드/다운로드(Range 지원)
- `ls`, `stat`, `exists`, `find` — 조회, cursor 기반 페이지네이션

전체 엔드포인트는 `api/v1/namespaces/:namespaceId/fs/*` 아래에 있다
(`src/vfs/fs.controller.ts`). 호출 서버가 로컬 파일시스템을 다루듯 Storix를
다룰 수 있게 하는 것이 설계 목표다. API 계약 전체는 `apps/api/openapi.yaml`
참고(초안 — `docs/ROADMAP.md` API-01).

### Blob-level Copy-on-Write

같은 namespace 안에서 `cp`는 파일 콘텐츠를 복사하지 않는다. 새 VFS Node가
원본과 같은 immutable Blob을 참조하며 `reference_count`만 증가시킨다.
대용량 파일이나 디렉터리 recursive copy가 MinIO I/O 없이 즉시 끝난다. 이후
어느 한쪽 Node에 내용을 쓰면 그 Node만 새 Blob으로 교체되고 다른 참조자는
영향받지 않는다. 참조 카운트가 0이 되면 grace period 이후 GC가 회수한다.

자세한 배경: `apps/api/docs/adr/0003-file-copy-blob-level-cow.md`,
`apps/api/docs/adr/0006-gc-zero-since-grace-period.md`.

## 설치

### 사전 준비

- 컨테이너 런타임 중 하나:
  - Docker Engine + Docker Compose v2(`docker compose` 플러그인)
  - Podman 4 이상 + podman-compose 1.x. Podman 3.x는 `depends_on`의
    healthcheck 조건을 무시해 기동 순서가 보장되지 않는다.
- git
- Postgres 16과 S3 호환 스토리지(VersityGW/MinIO/AWS S3). 이미 운영 중인 것에
  붙거나, 아래 override 파일로 컨테이너를 함께 띄운다.

compose 파일은 compose-spec 표준 문법(`profiles`, `depends_on.condition`, YAML
앵커)만 사용해 Docker/Podman에서 같은 파일·같은 옵션으로 동작한다.
배포 단위는 소스 빌드다 — `up --build`가 `apps/api/Dockerfile`로 이미지를
만든다. 태그 릴리즈마다 `ghcr.io/cp949/storix:vX.Y.Z`로 사전 빌드 이미지도
나가지만(`docs/deployment/release.md`), 이 compose 구성이 그 이미지를 직접
pull해 쓰도록 배선하는 작업은 아직이다.

### 소스 받기

```bash
git clone https://github.com/cp949/storix.git
cd storix
```

### `.env` 작성

```bash
cp .env.example .env
```

어떤 조합에서든 채워야 하는 값:

| 값 | 내용 |
|---|---|
| `STORIX_API_KEY` | `openssl rand -hex 32` 출력. 비어 있으면 compose가 기동을 거부한다 |
| `STORIX_DB_HOST`, `STORIX_DB_USERNAME`, `STORIX_DB_PASSWORD`, `STORIX_DB_NAME` | Postgres 접속 정보. `docker-compose.postgres.yml`을 겹치면 컨테이너 쪽 host/port는 재정의된다 |
| `STORIX_STORAGE_ENDPOINT`, `STORIX_STORAGE_ACCESS_KEY`, `STORIX_STORAGE_SECRET_KEY`, `STORIX_STORAGE_BUCKET` | 스토리지 접속 정보. 백엔드 override를 겹치면 endpoint/port/ssl은 재정의되고, 자격증명·버킷은 컨테이너 초기화에도 쓰인다 |

전체 목록·기본값은 [환경변수](#환경변수) 절, 각 값의 의미와 주의사항은
`.env.example` 주석에 있다.

### 백엔드 선택

`docker-compose.yml`(base)은 API 서버 `app`과 운영 잡(`migrate`/`gc`/`backup`/
`restore`)만 정의한다. Postgres와 스토리지는 `.env`의 접속 정보로 외부 서비스에
붙는다. 컨테이너를 추가하려면 override 파일을 `-f`로 겹친다.

| 파일 | 추가·재정의하는 것 | 상세 절차 |
|---|---|---|
| `docker-compose.versitygw.yml` | VersityGW 컨테이너 + 버킷 초기화. 목표 기본 백엔드(`docs/adr/0003-versitygw-primary-backend-and-topology.md`) | `README.versitygw.md` |
| `docker-compose.minio.yml` | MinIO 컨테이너 + 버킷 초기화 | `README.minio.md` |
| `docker-compose.s3.yml` | AWS S3. 컨테이너 없음, 엔드포인트/TLS/path-style만 고정 | `README.s3.md` |
| `docker-compose.postgres.yml` | 개발·검증용 Postgres 컨테이너 | 위 세 문서의 "개발" 명령 |

백엔드별 문서는 `.env` 설정, 기동, 동작 확인 curl 시퀀스, 운영 잡, 문제 해결까지
복사·붙여넣기로 따라갈 수 있게 자기완결로 쓰여 있다. 배치 결정 배경:
`docs/adr/0004-compose-file-layout.md`.

## 실행

Docker:

```bash
# 운영: VersityGW + 외부 Postgres(.env의 STORIX_DB_HOST)
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml up -d --build
# 개발·검증: 위 + 로컬 Postgres
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml up -d --build
# 외부 DB + 외부 S3 호환 스토리지: 접속 정보만
docker compose up -d --build
```

Podman — 명령 이름만 다르고 파일·옵션은 같다:

```bash
podman-compose -f docker-compose.yml -f docker-compose.versitygw.yml up -d --build
podman-compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml up -d --build
podman-compose up -d --build
```

기동 순서: 백엔드 컨테이너(healthcheck) → 버킷 초기화 → `migrate`(스키마
마이그레이션) → `app`. `migrate`는 profile이 아니라 `app`의 의존성이라 `up`마다
자동 실행되며, `ps`에서 `Exited (0)`이 정상이다.

동작 확인(`/health/ready`는 DB·스토리지 연결까지 검사한다):

```bash
until curl -sf http://localhost:3000/health/ready > /dev/null; do sleep 2; done && echo ready
```

namespace 생성부터 업로드·다운로드까지의 curl 시퀀스는 백엔드 README의
"동작 확인" 절에 있다.

### `-f` 나열 줄이기

- 원하는 override를 `docker-compose.override.yml`로 복사·수정한다(gitignore됨).
  docker compose·podman-compose 둘 다 `-f` 없이 `up`만으로 자동 병합한다.
- `.env`에 `COMPOSE_FILE=docker-compose.yml:docker-compose.versitygw.yml`을
  둔다(`.env.example` 상단 참고). docker compose만 `.env`의 `COMPOSE_FILE`을
  읽는다. podman-compose는 쉘에서 `export COMPOSE_FILE=...`한다.

### Podman 주의

- podman-compose는 `.env`의 `COMPOSE_FILE`을 읽지 않는다(위).
- podman-compose 1.6.0 이하는 `depends_on.condition: service_completed_successfully`를
  "컨테이너가 멈췄다"로만 판정하고 종료 코드를 보지 않는다(upstream
  containers/podman-compose#1481, 2026-07 main에 수정, 이 문서 시점 미릴리스).
  `migrate`가 실패해도 `app`이 기동할 수 있으므로 `podman-compose ... ps`에서
  `migrate`가 `Exited (0)`인지 확인한다.

## 운영 잡

base가 정의하는 운영 잡 4종 중 `migrate`는 위처럼 `up`마다 자동 실행되고,
나머지 3종은 profile로 켜서 명시적으로 실행한다. 배포에 쓴 것과 같은 `-f`
조합에 `--profile`을 더한다 — 조합이 다르면 잡이 다른 DB·스토리지를 본다.

| profile = 서비스 | 하는 일 | 상세 |
|---|---|---|
| `gc` | 참조가 0이 된 지 `STORIX_ORPHAN_GRACE_PERIOD`(기본 1일)를 넘긴 Blob과 metadata 없는 orphan object 회수 | `apps/api/docs/adr/0006-gc-zero-since-grace-period.md` |
| `backup` | Postgres dump + 스토리지 버킷 미러를 `STORIX_BACKUP_DIR/<타임스탬프>/`에 저장 | `docs/deployment/backup-restore.md` |
| `restore` | `STORIX_RESTORE_SOURCE_DIR`의 백업으로 복구. 대상에 데이터가 있으면 `STORIX_RESTORE_FORCE=true` 없이는 거부 | `docs/deployment/backup-restore.md` |

```bash
C="-f docker-compose.yml -f docker-compose.versitygw.yml"   # 배포에 쓴 조합

docker compose $C --profile gc run --rm gc
docker compose $C --profile backup run --rm backup
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose $C --profile restore run --rm restore
```

`gc`는 주기 실행이 전제다. 실행하지 않으면 삭제·덮어쓰기로 참조가 끊긴 Blob이
스토리지에 남는다. 호스트 crontab 예(매일 04:00, 저장소가 `/opt/storix`일 때):

```cron
0 4 * * * cd /opt/storix && docker compose -f docker-compose.yml -f docker-compose.versitygw.yml --profile gc run --rm gc >> /var/log/storix-gc.log 2>&1
```

`backup`과 `gc`는 겹치지 않게 스케줄한다. 백업 주기·보존은
`docs/deployment/backup-restore.md`, 여러 인스턴스가 DB를 공유할 때 잡을 한
곳에서만 실행하는 규칙은 `docs/deployment/multi-instance-versitygw.md`.

## 환경변수

Storix가 정의한 변수는 전부 `STORIX_` 접두어를 쓴다
(`docs/adr/0005-env-var-storix-prefix.md`). 구분: **필수** = 미설정이면 해당
프로세스가 부팅을 거부, **조건부** = 적힌 조건에서 필수, **선택** = 비우면
기본값. 읽는 곳: `모두` = app·migrate·gc·backup·restore, `app·잡` =
app·gc·backup·restore, `compose` = 코드가 읽지 않고 compose 보간에만 쓰이는 값.
값의 의미와 주의사항은 `.env.example` 주석에 있다.

| 변수 | 구분 | 기본값 | 읽는 곳 | 용도 |
|---|---|---|---|---|
| `STORIX_PUBLISH_PORT` | 선택 | `3000` | compose | `app` 컨테이너를 호스트에 노출하는 포트 |
| `STORIX_PORT` | 선택 | `3000` | app | app의 listen 포트. 컨테이너 안은 3000 고정, 호스트 직접 실행에서만 바꾼다 |
| `STORIX_DB_DRIVER` | 선택 | `postgres` | 모두 | `postgres` 또는 `sqlite`. `sqlite`면 `STORIX_DB_HOST` 등은 무시되고 `STORIX_DB_SQLITE_PATH`만 쓰인다. 현재 sqlite는 부팅·마이그레이션까지만 검증됨 — gc/backup/restore 잡과 일부 쓰기 경로는 아직 sqlite에서 동작하지 않는다 |
| `STORIX_DB_SQLITE_PATH` | 조건부 | — | 모두 | `STORIX_DB_DRIVER=sqlite`일 때 필수. sqlite 파일 경로 |
| `STORIX_DB_HOST` | 필수 | — | 모두 | Postgres 호스트. `docker-compose.postgres.yml`이 컨테이너 쪽을 `postgres`로 재정의 |
| `STORIX_DB_PORT` | 선택 | `5432` | 모두 | Postgres 포트. postgres override에서는 호스트 노출 포트로도 쓰인다 |
| `STORIX_DB_USERNAME` | 필수 | — | 모두 | Postgres 사용자. postgres override의 초기화 계정으로도 쓰인다 |
| `STORIX_DB_PASSWORD` | 필수 | — | 모두 | Postgres 비밀번호 |
| `STORIX_DB_NAME` | 필수 | — | 모두 | 데이터베이스 이름 |
| `STORIX_STORAGE_ENDPOINT` | 필수 | — | app·잡 | S3 호환 엔드포인트 호스트. 백엔드 override가 컨테이너 쪽을 재정의 |
| `STORIX_STORAGE_PORT` | 선택 | `9000` | app·잡 | 스토리지 포트. versitygw override는 `7070`으로 재정의 |
| `STORIX_STORAGE_USE_SSL` | 선택 | `false` | app·잡 | 스토리지 TLS 사용 여부 |
| `STORIX_STORAGE_ACCESS_KEY` | 필수 | — | app·잡 | 스토리지 access key. versitygw/minio override에서는 컨테이너 root 자격증명으로도 쓰인다 |
| `STORIX_STORAGE_SECRET_KEY` | 필수 | — | app·잡 | 스토리지 secret key. 위와 같음 |
| `STORIX_STORAGE_BUCKET` | 필수 | — | app·잡 | 버킷 이름. override가 기동 시 생성한다 |
| `STORIX_STORAGE_PATH_STYLE` | 선택 | `true` | app·잡 | path-style 주소 사용. AWS S3는 `docker-compose.s3.yml`이 `false`로 고정 |
| `STORIX_STORAGE_REGION` | 조건부 | — | app·잡 | presigned download 사용 시 필수(예: `us-east-1`). 비우면 리전 자동 조회가 컨테이너 자기 자신으로 향해 500 |
| `STORIX_STORAGE_PUBLIC_ENDPOINT` | 선택 | — | app·잡 | presigned download URL의 외부 접근 주소. 비우면 그 API만 실패한다 |
| `STORIX_STORAGE_PUBLIC_PORT` | 선택 | `9000` | app·잡 | 외부 접근 포트 |
| `STORIX_STORAGE_PUBLIC_USE_SSL` | 선택 | `false` | app·잡 | 외부 접근 TLS 여부 |
| `STORIX_VERSITYGW_DATA_PATH` | 선택 | — | compose | `docker-compose.versitygw.yml` 전용. `/`로 시작하는 절대 경로면 bind mount, 비우면 named volume |
| `STORIX_NGINX_PUBLIC_PORT` | 선택 | `8443` | compose | `docs/deployment/compose.nginx-demo.yml` 전용 호스트 포트 |
| `STORIX_MAX_FILE_SIZE_BYTES` | 선택 | `5368709120` | app | 업로드 상한(5 GiB) |
| `STORIX_MAX_SYNC_DELETE_NODES` | 선택 | `1000` | app | recursive rm이 동기 처리하는 노드 수 상한 |
| `STORIX_MAX_SYNC_COPY_NODES` | 선택 | `1000` | app | recursive cp 노드 수 상한 |
| `STORIX_PRESIGNED_URL_EXPIRY_SECONDS` | 선택 | `300` | app | presigned URL 만료(초). 상한 `604800`(7일), 초과하면 부팅 거부 |
| `STORIX_ORPHAN_GRACE_PERIOD` | 선택 | `86400` | gc | 참조 0 이후 회수까지 유예(초) |
| `STORIX_GC_MIN_INTERVAL` | 선택 | `3600` | gc | 멀티 인스턴스에서 중복 실행을 막는 최소 재실행 간격(초). advisory lock + 이 간격으로 함대 전체에서 한 인스턴스만 실행되게 한다 |
| `STORIX_API_KEY` | 필수 | — | app | 서비스 간 인증 키. 공백만 있어도 거부 |
| `STORIX_API_KEY_PREVIOUS` | 선택 | — | app | 키 로테이션 중 함께 유효한 이전 키 |
| `STORIX_ENCRYPTION_MASTER_KEY` | 조건부 | — | app | ENCRYPTED namespace가 하나라도 있으면 필수. 64자 hex. 분실 시 복호화 불가 |
| `STORIX_SENTRY_DSN` | 선택 | — | app·잡 | 설정 시 500 에러·잡 실패를 Sentry로 리포팅 |
| `STORIX_BACKUP_DIR` | 필수 | — | backup | 백업 저장 디렉터리. compose 실행에서는 `/backups`(호스트 `./backups`)가 기본 |
| `STORIX_RESTORE_SOURCE_DIR` | 필수 | — | restore | 복구할 백업 디렉터리. 빈 문자열도 거부 |
| `STORIX_RESTORE_FORCE` | 선택 | `false` | restore | 대상에 데이터가 있어도 덮어쓴다(되돌릴 수 없음) |

## 개발

호스트에서 API 서버를 직접 실행하려면 Node.js `>=24.18`과 pnpm 11이 필요하다
(`corepack enable`). 호스트 실행은 compose를 거치지 않으므로 `.env`를 쉘로
내보내야 한다 — `migrate`는 `.env` 파일을 읽지 않고, app은 실행 디렉터리
(`apps/api`)의 `.env`만 읽는다.

```bash
pnpm install

# 의존 컨테이너만 띄운다. versitygw는 호스트 포트를 노출하지 않으므로
# docker-compose.override.yml(gitignore됨)로 노출을 추가한다.
cat > docker-compose.override.yml <<'EOF'
services:
  versitygw:
    ports:
      - '127.0.0.1:7070:7070'
EOF
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml -f docker-compose.override.yml up -d postgres versitygw-init

# .env를 쉘로 내보내고 스토리지 포트를 VersityGW(7070)에 맞춘다.
set -a; . ./.env; set +a
export STORIX_STORAGE_PORT=7070

pnpm --filter @storix/api migration:run
pnpm --filter @storix/api start:dev
```

테스트:

```bash
pnpm --filter @storix/api test               # unit
pnpm --filter @storix/api test:integration   # testcontainers — Docker/Podman 소켓 필요
```

기여자·에이전트의 로컬 검증 규약(Podman 기본, compose 검증 방법, 알려진 환경
결함)은 `docs/agents/local-verification.md`.

## 문서

- 컨텍스트 목록: `CONTEXT-MAP.md`
- api 도메인 용어: `apps/api/CONTEXT.md`
- API 계약(OpenAPI, 초안): `apps/api/openapi.yaml`
- 시스템 전역 아키텍처 결정: `docs/adr/`, api 컨텍스트 결정: `apps/api/docs/adr/`
- 배포/운영 절차(reverse-proxy, 백업/복구, 업그레이드, 릴리즈, 멀티 인스턴스): `docs/deployment/`
- 에이전트·기여자 규약: `AGENTS.md`, `docs/agents/`
- 상용화 로드맵: `docs/ROADMAP.md`
- 변경 이력: `CHANGELOG.md`
