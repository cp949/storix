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
- `GET /api/v2/public/{ns}/fs/download|content` — `accessPolicy=PUBLIC` namespace의
  무인증 다운로드(Range 지원). 다운로드 2개 라우트만 존재하며 목록 조회·쓰기는 없다.
  `accessPolicy`는 namespace 생성 시 결정되고 변경할 수 없다. `ENCRYPTED` namespace는
  `PUBLIC`으로 만들 수 없다.

전체 엔드포인트는 `api/v2/namespaces/:namespaceId/fs/*` 아래에 있다
(`src/vfs/fs.controller.ts`). 호출 서버가 로컬 파일시스템을 다루듯 Storix를
다룰 수 있게 하는 것이 설계 목표다. API 계약 전체는 `apps/api/openapi.yaml`
참고(초안 — `docs/ROADMAP.md` API-01).

### namespace 한도 조회

서비스 API key로 `GET /api/v2/namespaces/{namespaceId}`를 호출하면 현재 적용되는
단일 파일 최대 크기를 `limits.maxFileSizeBytes`에서 확인할 수 있다. 값은 바이트 단위
10진 문자열이며, namespace 재정의와 `STORIX_MAX_FILE_SIZE_BYTES` 전역 상한 중
작은 값이다. 전역 설정이 없으면 `5368709120`(5 GiB)을 사용한다. 같은 응답의
`quota.limitBytes`는 namespace의 적용 논리 저장량 상한, `quota.usedBytes`는
live FILE과 보존 snapshot·휴지통 FILE entry의 논리 크기 합계다. 두 quota 값도 바이트
단위 10진 문자열이다. namespace 생성·목록·quota 변경 응답도 같은 `limits`·`quota`
필드를 포함한다. `quota.trash.retainedNodeCount`와 `maxRetainedNodes`는 현재 보존
node 수와 적용 상한이다.

### 삭제 복구

파일 또는 디렉터리를 삭제하면 subtree 전체가 하나의 휴지통 항목으로 30일간
보존된다. `/fs/rm`·`/fs/rmdir`의 204 응답은 `X-Trash-Id` 헤더를, 조건부
`kind: delete` 응답은 `trashId`를 반환한다. 서비스 key로 `GET /fs/trash`를 조회하고
`POST /fs/trash/{trashId}/restore`에 `Idempotency-Key`와 `X-Mutation-Scope`를
보내 원래 경로 또는 `targetPath`로 복구한다. 복구는 원래 node ID를 되살리고 새
revision을 발급하며, 이미 존재하는 목적지는 덮어쓰지 않는다. 직접 영구 삭제
`POST /fs/trash/{trashId}/purge`에는 별도의 관리자 key가 필요하다.

기본 보존 상한은 namespace당 100000 node(`STORIX_MAX_RETAINED_TRASH_NODES`)다.
삭제 뒤 live byte는 trash byte로 옮겨지고, 만료 시각 뒤에도 GC purge가 완료될
때까지 quota에 포함된다. 만료 항목은 복구할 수 없으며 GC가 DB 시각 기준으로
배치 purge한다. 다른 live 파일·snapshot·휴지통이 공유하는 Blob은 보존된다.
운영 배포 DB migration, 실제 백업 복원 및 외부 consumer 연동 검증은 별도다.

### namespace 변경 feed

`GET /api/v2/namespaces/{namespaceId}/fs/changes`는 서비스 Bearer key로 인증된
ACTIVE namespace의 파일·디렉터리 변경을 반환한다. `change-feed` capability는 기본
비활성이다. namespace 생성 후 `STORIX_VFS_CAPABILITIES_CONFIG_PATH`의 시작 JSON
설정에서 전역과 해당 namespace에 `change-feed`를 허용하고 app을 재시작한다. 예:

```json
{
  "globalAllowedCapabilities": ["change-feed"],
  "namespaceAllowedCapabilities": {
    "11111111-1111-4111-8111-111111111111": ["change-feed"]
  }
}
```

서비스 Bearer key로 `GET /api/v2/namespaces/{id}/capabilities`를 조회해 활성화를
확인한다. 비활성이면 feed 요청은 409 `VFS_FEATURE_DISABLED`이고 일반 파일 API는
계속 사용할 수 있다. 처음 checkpoint를 받은 namespace는 capability를 나중에
꺼도 journal 기록을 이어가므로 재활성화 후 보존 기간 안의 cursor를 재사용할 수 있다.

전체 동기화는 **cursor 없이 feed 호출 → 반환된 `nextCursor` 보존 → 기존 `ls`로
전체 열거 → 보존한 cursor로 변경 페이지 조회** 순서다. 열거 중 `ls` cursor가
무효화되면 feed checkpoint를 유지하고 열거를 처음부터 다시 한다. 이벤트는
namespace 순서 번호의 오름차순이며 `created`·`updated`·`moved`·`deleted`를
포함한다. 이동에는 이전 경로가, 삭제에는 마지막 경로가 들어간다. 응답의
`operationId`·`operationIndex`·`operationCount`는 한 transaction의 이벤트를
식별하며 페이지 경계가 그 transaction을 나눌 수 있다.

`cursor`와 선택적 `limit`(기본 100, 최대 1000)으로 다음 페이지를 받는다.
각 페이지의 변경 적용과 `nextCursor` 저장은 소비자 DB에서 원자적으로 처리하고,
재조회로 겹치는 이벤트는 `sequence`로 중복 제거한다. `hasMore`는 조회 시점의
다음 페이지 존재 여부다. 빈 페이지의 `nextCursor`로 계속 polling할 수 있다.
cursor는 내부 값을 해석하지 않는 불투명 토큰이다. 잘못되거나 다른 namespace의
cursor는 400 `VFS_INVALID_CURSOR`다. GC가 DB 시각으로 오래된 이벤트를 정리하는
기본 보존 기간은 30일(`STORIX_VFS_CHANGE_RETENTION_DAYS`)이다. cursor가 보존
경계 이전이면 410 `VFS_CHANGE_CURSOR_EXPIRED`이므로 새 checkpoint를 받고 전체
열거부터 다시 한다. compose의 `gc` 서비스는 `.env`의 이 값을 전달하며, 값을
바꾸면 다음 GC 실행부터 적용된다. 실제 운영 활성화, 특정 소비자 연동, production 복구는 이
변경에서 검증하지 않았다. 상세 계약은 [설계 문서](docs/design/08-namespace-change-feed.md)와
[OpenAPI](apps/api/openapi.yaml)를 따른다.

### Blob-level Copy-on-Write

같은 namespace 안에서 `cp`는 파일 콘텐츠를 복사하지 않는다. 새 VFS Node가
원본과 같은 immutable Blob을 참조하며 `reference_count`만 증가시킨다.
대용량 파일이나 디렉터리 recursive copy가 스토리지 I/O 없이 즉시 끝난다. 이후
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
- Postgres 16과 S3 호환 스토리지(VersityGW/AWS S3 등). 이미 운영 중인 것에
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

| 값                                                                                                           | 내용                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `STORIX_API_KEY`                                                                                             | `openssl rand -hex 32` 출력. 비어 있으면 compose가 기동을 거부한다                                                      |
| `STORIX_DB_HOST`, `STORIX_DB_USERNAME`, `STORIX_DB_PASSWORD`, `STORIX_DB_NAME`                               | Postgres 접속 정보. `docker-compose.postgres.yml`을 겹치면 컨테이너 쪽 host/port는 재정의된다                           |
| `STORIX_STORAGE_ENDPOINT`, `STORIX_STORAGE_ACCESS_KEY`, `STORIX_STORAGE_SECRET_KEY`, `STORIX_STORAGE_BUCKET` | 스토리지 접속 정보. 백엔드 override를 겹치면 endpoint/port/ssl은 재정의되고, 자격증명·버킷은 컨테이너 초기화에도 쓰인다 |

전체 목록·기본값은 [환경변수](#환경변수) 절, 각 값의 의미와 주의사항은
`.env.example` 주석에 있다.

### 백엔드 선택

`docker-compose.yml`(base)은 API 서버 `app`과 운영 잡(`migrate`/`gc`/`backup`/
`restore`)만 정의한다. Postgres와 스토리지는 `.env`의 접속 정보로 외부 서비스에
붙는다. 컨테이너를 추가하려면 override 파일을 `-f`로 겹친다.

| 파일                           | 추가·재정의하는 것                                                                                            | 상세 절차                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `docker-compose.versitygw.yml` | VersityGW 컨테이너 + 버킷 초기화. 목표 기본 백엔드(`docs/adr/0003-versitygw-primary-backend-and-topology.md`) | `README.versitygw.md`    |
| `docker-compose.s3.yml`        | AWS S3. 컨테이너 없음, 엔드포인트/TLS/path-style만 고정                                                       | `README.s3.md`           |
| `docker-compose.postgres.yml`  | 개발·검증용 Postgres 컨테이너                                                                                 | 위 세 문서의 "개발" 명령 |
| `docker-compose.sqlite.yml`    | SQLite 드라이버 설정. DB 컨테이너 없이 named volume의 파일을 사용하며 단일 프로세스 배포 전제                 | `README.sqlite.md`       |

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

| profile = 서비스 | 하는 일                                                                                                                                                                                   | 상세                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `gc`             | 참조가 0이 된 지 `STORIX_ORPHAN_GRACE_PERIOD`(기본 1일)를 넘긴 Blob과 metadata 없는 orphan object 회수, 변경 feed 보존 기간 경과 이벤트 정리, 종결된 재개 업로드 세션의 staging 조각 삭제 | `apps/api/docs/adr/0006-gc-zero-since-grace-period.md` |
| `backup`         | Postgres dump + 스토리지 버킷 미러를 `STORIX_BACKUP_DIR/<타임스탬프>/`에 저장                                                                                                             | `docs/deployment/backup-restore.md`                    |
| `restore`        | `STORIX_RESTORE_SOURCE_DIR`의 백업으로 복구. 대상에 데이터가 있으면 `STORIX_RESTORE_FORCE=true` 없이는 거부                                                                               | `docs/deployment/backup-restore.md`                    |

```bash
C="-f docker-compose.yml -f docker-compose.versitygw.yml"   # 배포에 쓴 조합

docker compose $C --profile gc run --rm gc
docker compose $C --profile backup run --rm backup
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose $C --profile restore run --rm restore
```

`gc`는 주기 실행이 전제다. 실행하지 않으면 삭제·덮어쓰기로 참조가 끊긴 Blob이
스토리지에 남는다. 재개 업로드를 켠 배포에서는 완료·취소·만료된 세션의 조각도 GC 전까지
staging에 남아 `maxStagedBytes`를 차지한다. 이 한도가 차면 새 조각 저장이
`413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`가 되므로 실행 주기는 한도를 채우는 데 걸리는 시간보다
짧게 잡는다. `STORIX_GC_MIN_INTERVAL`(기본 3600초) 안에 다시 실행하면 건너뛴다. 호스트 crontab 예(매일 04:00, 저장소가 `/opt/storix`일 때):

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

| 변수                                      | 구분   | 기본값        | 읽는 곳 | 용도                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------ | ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORIX_PUBLISH_HOST`                     | 선택   | `0.0.0.0`     | compose | `app` 컨테이너의 호스트 bind 주소. host Nginx만 접근시키려면 `127.0.0.1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `STORIX_PUBLISH_PORT`                     | 선택   | `3000`        | compose | `app` 컨테이너를 호스트에 노출하는 포트                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `STORIX_PORT`                             | 선택   | `3000`        | app     | app의 listen 포트. 컨테이너 안은 3000 고정, 호스트 직접 실행에서만 바꾼다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STORIX_MAX_TOTAL_LOGICAL_BYTES`          | 선택   | `53687091200` | app     | Namespace 논리 사용량 전역 상한(50 GiB). namespace별 override는 이 값 이하여야 한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `STORIX_VFS_CAPABILITIES_CONFIG_PATH`     | 선택   | —             | app     | 시작 시 읽는 선택 VFS capability JSON 파일 경로. 비우면 선택 기능 전부 비활성. JSON은 `globalAllowedCapabilities` 문자열 목록, `namespaceAllowedCapabilities`(namespace UUID를 키로 하는 문자열 목록 객체), 선택 `defaultEnabledCapabilities`(항목이 없는 모든 namespace에 켜는 기본 활성 목록)만 허용하며, 파일·구문·schema·namespace 존재·미등록 capability 검증 실패 시 시작을 거부한다. `resumable-upload`와 `change-feed`가 기본 비활성으로 등록되어 있으며, 활성 상태는 서비스 Bearer 인증이 필요한 `GET /api/v2/namespaces/{id}/capabilities`에서 조회한다 |
| `STORIX_VFS_CHANGE_RETENTION_DAYS`        | 선택   | `30`          | gc      | 변경 feed 이벤트 보존 기간(양의 정수 일수). GC가 DB 시각으로 오래된 이벤트를 정리하고 보존 경계를 전진시킨다. 만료 cursor는 410과 전체 재동기화가 필요하다                                                                                                                                                                                                                                                                                                                                                                                                        |
| `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`  | 조건부 | —             | app     | 재개 업로드 정책 JSON 경로. `resumable-upload`를 전역 또는 namespace에서 허용하면 필수다. 엄격한 schema·기본값·활성 순서는 아래 참고                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `STORIX_ADMIN_API_KEY`                    | 선택   | —             | app     | `/api/v2/admin/*` 전용 관리자 Bearer key. 비우면 관리자 API는 모두 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `STORIX_ADMIN_API_KEY_PREVIOUS`           | 선택   | —             | app     | 관리자 키 교체 기간에만 허용하는 이전 Bearer key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `STORIX_DB_DRIVER`                        | 선택   | `postgres`    | 모두    | `postgres` 또는 `sqlite`. `sqlite`면 `STORIX_DB_HOST` 등은 무시되고 `STORIX_DB_SQLITE_PATH`만 쓰인다. 단일 프로세스 all-in-one 배포 전제이며 compose에서는 `docker-compose.sqlite.yml`을 겹친다 — 상세는 `README.sqlite.md`                                                                                                                                                                                                                                                                                                                                       |
| `STORIX_DB_SQLITE_PATH`                   | 조건부 | —             | 모두    | `STORIX_DB_DRIVER=sqlite`일 때 필수. sqlite 파일 경로                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `STORIX_DB_HOST`                          | 필수   | —             | 모두    | Postgres 호스트. `docker-compose.postgres.yml`이 컨테이너 쪽을 `postgres`로 재정의                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORIX_DB_PORT`                          | 선택   | `5432`        | 모두    | Postgres 포트. postgres override에서는 호스트 노출 포트로도 쓰인다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORIX_DB_USERNAME`                      | 필수   | —             | 모두    | Postgres 사용자. postgres override의 초기화 계정으로도 쓰인다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `STORIX_DB_PASSWORD`                      | 필수   | —             | 모두    | Postgres 비밀번호                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STORIX_DB_NAME`                          | 필수   | —             | 모두    | 데이터베이스 이름                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STORIX_STORAGE_ENDPOINT`                 | 필수   | —             | app·잡  | S3 호환 엔드포인트 호스트. 백엔드 override가 컨테이너 쪽을 재정의                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STORIX_STORAGE_PORT`                     | 선택   | `9000`        | app·잡  | 스토리지 포트. versitygw override는 `7070`으로 재정의                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `STORIX_STORAGE_USE_SSL`                  | 선택   | `false`       | app·잡  | 스토리지 TLS 사용 여부                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `STORIX_STORAGE_ACCESS_KEY`               | 필수   | —             | app·잡  | 스토리지 access key. versitygw override에서는 컨테이너 root 자격증명으로도 쓰인다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STORIX_STORAGE_SECRET_KEY`               | 필수   | —             | app·잡  | 스토리지 secret key. 위와 같음                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `STORIX_STORAGE_BUCKET`                   | 필수   | —             | app·잡  | 버킷 이름. override가 기동 시 생성한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `STORIX_STORAGE_PATH_STYLE`               | 선택   | `true`        | app·잡  | path-style 주소 사용. AWS S3는 `docker-compose.s3.yml`이 `false`로 고정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `STORIX_STORAGE_REGION`                   | 선택   | `us-east-1`   | app·잡  | 서명에 쓰는 리전. 백엔드가 리전을 지정해 운영되면(VersityGW `--region`, AWS S3 버킷 리전) 같은 값을 넣는다                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `STORIX_STORAGE_PUBLIC_ENDPOINT`          | 선택   | —             | app·잡  | presigned download URL의 외부 접근 주소. 비우면 그 API만 실패한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STORIX_STORAGE_PUBLIC_PORT`              | 선택   | `9000`        | app·잡  | 외부 접근 포트                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `STORIX_STORAGE_PUBLIC_USE_SSL`           | 선택   | `false`       | app·잡  | 외부 접근 TLS 여부                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORIX_VERSITYGW_DATA_PATH`              | 선택   | —             | compose | `docker-compose.versitygw.yml` 전용. `/`로 시작하는 절대 경로면 bind mount, 비우면 named volume                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `STORIX_NGINX_PUBLIC_PORT`                | 선택   | `8443`        | compose | `docs/deployment/compose.nginx-demo.yml` 전용 호스트 포트                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STORIX_SCENARIO_VERSITYGW_PORT`          | 선택   | `7070`        | compose | `co-located-nginx-mtls` 시나리오에서 host Nginx가 접근할 loopback 포트                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `STORIX_MAX_FILE_SIZE_BYTES`              | 선택   | `5368709120`  | app     | 업로드 상한(5 GiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORIX_MAX_SYNC_DELETE_NODES`            | 선택   | `1000`        | app     | recursive rm이 동기 처리하는 노드 수 상한                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STORIX_MAX_SYNC_COPY_NODES`              | 선택   | `1000`        | app     | recursive cp 노드 수 상한                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STORIX_MAX_SYNC_SNAPSHOT_NODES`          | 선택   | `1000`        | app     | snapshot 한 건의 최대 manifest 노드 수(디렉터리 포함)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `STORIX_MAX_SNAPSHOT_BYTES`               | 선택   | `5368709120`  | app     | snapshot 한 건의 논리적 파일 크기 합계 상한(5 GiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORIX_MAX_RETAINED_SNAPSHOT_NODES`      | 선택   | `100000`      | app     | namespace 내 보존 중인 모든 snapshot의 manifest 노드 수 합계 상한                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STORIX_MAX_RETAINED_SNAPSHOT_BYTES`      | 선택   | `53687091200` | app     | namespace 내 보존 중인 모든 snapshot의 논리적 파일 크기 합계 상한(50 GiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STORIX_MAX_RETAINED_TRASH_NODES`         | 선택   | `100000`      | app     | namespace별 보존 휴지통 node 수 상한. 양의 안전 정수만 허용하며 만료 뒤 GC purge 완료까지 과금                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `STORIX_MUTATION_LEASE_SECONDS`           | 선택   | `60`          | app     | 조건부 업로드 claim lease(초). 업로드 중 이 시간의 1/3 간격으로 갱신                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `STORIX_MUTATION_MAX_UPLOAD_SECONDS`      | 선택   | `86400`       | app     | 조건부 raw 업로드와 재개 업로드 조각 요청의 최대 지속 시간(초, 기본 24시간)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `STORIX_VFS_EXPIRY_MIN_SECONDS`           | 선택   | `60`          | app     | 새 FILE 만료 입력의 최소 초. 양의 안전 정수이며 최대값 이하여야 함                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORIX_VFS_EXPIRY_MAX_SECONDS`           | 선택   | `2592000`     | app     | 새 FILE 만료 입력의 최대 초. 최소값 이상인 양의 안전 정수이며 PostgreSQL INTEGER 저장 범위로 `2147483647`초 이하                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `STORIX_PRESIGNED_URL_EXPIRY_SECONDS`     | 선택   | `300`         | app     | presigned URL 만료(초). 상한 `604800`(7일), 초과하면 부팅 거부                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `STORIX_ORPHAN_GRACE_PERIOD`              | 선택   | `86400`       | gc      | 참조 0 이후 회수까지 유예(초)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `STORIX_GC_MIN_INTERVAL`                  | 선택   | `3600`        | gc      | 멀티 인스턴스에서 중복 실행을 막는 최소 재실행 간격(초). advisory lock + 이 간격으로 함대 전체에서 한 인스턴스만 실행되게 한다                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `STORIX_GC_MAX_ROWS_PER_STAGE`            | 선택   | `200000`      | gc      | 한 실행에서 단계마다 처리하는 행 수 예산. 소진된 단계는 재개 위치를 저장하고 다음 실행이 이어간다. 단위는 단계가 정한다(change feed 정리는 읽은 만료 이벤트 수)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `STORIX_NAMESPACE_DELETED_RETENTION_DAYS` | 선택   | `30`          | gc      | 삭제가 끝난(`DELETED`) namespace의 행을 gc가 물리 삭제하기까지의 보존 기간(일). 이 기간 동안만 삭제 상태 조회와 같은 key의 삭제 재요청 재생이 된다. 물리 삭제는 되돌릴 수 없다. 설정에 적은 namespace(`STORIX_VFS_CAPABILITIES_CONFIG_PATH`)가 물리 삭제되면 시작이 거부되므로 삭제한 namespace는 설정에서 지운다                                                                                                                                                                                                                                                 |
| `STORIX_API_KEY`                          | 필수   | —             | app     | 서비스 간 인증 키. 공백만 있어도 거부                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `STORIX_API_KEY_PREVIOUS`                 | 선택   | —             | app     | 키 로테이션 중 함께 유효한 이전 키                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORIX_ENCRYPTION_MASTER_KEY`            | 조건부 | —             | app     | ENCRYPTED namespace가 하나라도 있으면 필수. 64자 hex. 분실 시 복호화 불가                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STORIX_SENTRY_DSN`                       | 선택   | —             | app·잡  | 설정 시 500 에러·잡 실패를 Sentry로 리포팅                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `STORIX_BACKUP_DIR`                       | 필수   | —             | backup  | 백업 저장 디렉터리. compose 실행에서는 `/backups`(호스트 `./backups`)가 기본                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `STORIX_RESTORE_SOURCE_DIR`               | 필수   | —             | restore | 복구할 백업 디렉터리. 빈 문자열도 거부                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `STORIX_RESTORE_FORCE`                    | 선택   | `false`       | restore | 대상에 데이터가 있어도 덮어쓴다(되돌릴 수 없음)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 재개 업로드 활성화

`resumable-upload`는 기본 비활성이다. 활성화할 namespace를 만든 뒤 두 JSON 파일을 준비하고 `STORIX_VFS_CAPABILITIES_CONFIG_PATH`와 `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`를 설정해 app을 재시작한다. 두 파일은 시작 시 한 번만 읽는다. 다음 UUID와 한도는 **예시**이며 배포에서 실제 용량과 동시 요청 수에 맞게 선택해야 한다. 활성 결과는 서비스 Bearer 인증으로 `GET /api/v2/namespaces/{id}/capabilities`에서 확인한다.

Capability 파일:

```json
{
  "globalAllowedCapabilities": ["resumable-upload"],
  "namespaceAllowedCapabilities": {
    "11111111-1111-4111-8111-111111111111": ["resumable-upload"]
  }
}
```

회원마다 namespace를 만드는 배포는 namespace를 나열하지 않고 `defaultEnabledCapabilities`로 새 namespace까지 재시작 없이 켠다. `namespaceAllowedCapabilities`에 항목이 있는 namespace는 기본 목록 대신 그 값을 쓰며 빈 목록은 비활성이다. 전역 허용이 항상 최종 상한이다.

```json
{
  "globalAllowedCapabilities": ["resumable-upload"],
  "namespaceAllowedCapabilities": {},
  "defaultEnabledCapabilities": ["resumable-upload"]
}
```

세션 정책 파일(`namespaces`는 선택 override이며 항목이 없는 namespace는 `global` 한도를 쓴다):

```json
{
  "global": {
    "maxStagedBytes": "10737418240",
    "maxActiveSessions": 100,
    "partSizeBytes": 16777216,
    "inactivitySeconds": 86400,
    "maxLifetimeSeconds": 604800
  },
  "namespaces": {
    "11111111-1111-4111-8111-111111111111": {
      "maxStagedBytes": "1073741824",
      "maxActiveSessions": 10
    }
  }
}
```

정책 최상위는 `global`, `namespaces`만 허용한다. `global`에는 양의 10진 문자열 `maxStagedBytes`(signed int64 이하)와 양의 안전한 정수 `maxActiveSessions`가 필수다. 선택 값인 `partSizeBytes`는 기본 16777216 bytes, 최대 2147483647 bytes이고, `inactivitySeconds`는 기본 86400초, `maxLifetimeSeconds`는 기본 604800초다. 세 값은 양의 안전한 정수이며 비활동 기간은 최대 수명 이하여야 한다. `namespaces`의 UUID별 두 필수 한도는 해당 전역 한도 이하여야 한다. 활성 namespace의 정책 누락, 정규화 후 중복 UUID, 추가 필드·잘못된 값은 시작 오류다. 파일 전체에는 기존 `STORIX_MAX_FILE_SIZE_BYTES`(기본 5 GiB)와 namespace 적용 상한 중 낮은 값이 적용된다. 각 조각 요청에는 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`(기본 86400초)가 적용된다. capability를 끈 뒤에도 세션 조회·취소·완전 업로드된 세션의 완료와 GC 정리는 가능하다. GC 잡이 만료·객체 삭제·30일 경과 세션 정리를 수행하므로 배포에서 GC 실행을 유지해야 한다. 자세한 API 계약은 `apps/api/openapi.yaml`과 `docs/design/07-resumable-upload.md`를 따른다.

### 불변 VFS snapshot

`/api/v2/namespaces/{namespaceId}/fs/snapshots`에서 현재 파일(FILE)이나
디렉터리 하위 트리(TREE)의 불변 manifest를 만든다. FILE은 고정된 binary bytes와
MIME 조회 및 revision 조건부 파일 복원을 지원한다. TREE는 manifest 목록과
파일별 내용 조회를 지원한다. TREE 전체 복원은 제공하지 않는다. snapshot ID는
현재 VFS 경로의 revision과 별개이며, 원본 파일 변경·삭제 후에도 snapshot의
내용을 읽을 수 있다.

작업당 한도는 snapshot 하나의 manifest 항목 수(디렉터리 포함)와 파일 크기의
논리적 합계에 적용한다. 보존 총량은 namespace 안의 모든 snapshot에 같은
방식으로 적용한다. 같은 Blob이 여러 항목에 나타나면 항목마다 계산한다.
namespace별 snapshot 한도 재정의는 전역 한도보다 낮게만 적용된다. snapshot은
자동 만료되지 않으므로 `POST .../snapshots/{snapshotId}/delete`로 명시적으로
삭제해야 보존 예산과 Blob 참조가 해제된다. 보존 중인 snapshot은 Blob을 계속
참조하므로 원본 파일을 삭제해도 GC가 그 Blob을 회수하지 않는다.

snapshot 복구와 마이그레이션 롤백에는 DB의 metadata·manifest와 Blob 오브젝트를
**같은 시점**의 상태로 함께 백업한 자료가 필요하다. 운영 백업 시 쓰기와 GC를
멈추고 DB·버킷 상태를 일관되게 확보해야 한다. 백업 잡은 쓰기를 자동으로
중지하지 않는다. DB 마이그레이션의 `down()`만
실행하면 이후 생성된 snapshot 데이터는 보존되지 않는다. 기존
`docs/deployment/backup-restore.md`의 백업/복구 절차를 참조한다.

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

pnpm --filter @cp949/storix-api migration:run
pnpm --filter @cp949/storix-api start:dev
```

테스트:

```bash
pnpm --filter @cp949/storix-api test               # unit
pnpm --filter @cp949/storix-api test:integration   # testcontainers — Docker/Podman 소켓 필요
```

기여자·에이전트의 로컬 검증 규약(Podman 기본, compose 검증 방법, 알려진 환경
결함)은 `docs/agents/local-verification.md`.

## 문서

- WAS에서 업무 데이터와 파일 저장하기: [두 가지 업로드 사용 패턴](docs/guides/was-file-upload-patterns.md)
- WAS에서 파일 다운로드 제공하기: [권한 확인과 직접 다운로드 사용 패턴](docs/guides/was-file-download-patterns.md)
- WAS와 Storix의 서비스 간 신뢰: [인증과 네트워크 구성 방법](docs/guides/was-storix-service-trust.md)
- 컨텍스트 목록: `CONTEXT-MAP.md`
- api 도메인 용어: `apps/api/CONTEXT.md`
- API 계약(OpenAPI): `apps/api/openapi.yaml`
- 시스템 전역 아키텍처 결정: `docs/adr/`, api 컨텍스트 결정: `apps/api/docs/adr/`
- 배포/운영 절차(reverse-proxy, 백업/복구, 업그레이드, 릴리즈, 멀티 인스턴스): `docs/deployment/`
- 선택형 배포 시나리오와 실제 설정: `docs/deployment/scenarios/`
- 에이전트·기여자 규약: `AGENTS.md`, `docs/agents/`
- 상용화 로드맵: `docs/ROADMAP.md`
- 변경 이력: `CHANGELOG.md`
