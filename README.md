# Storix

Storix는 호출 서버가 사용하는 독립 VFS(Virtual File System) 저장 서버다.
호출 서버의 책임:

- 파일의 업무적 의미 관리.
- 최종 사용자 인증·권한 판단.

## 핵심 기능

### 파일시스템식 API

경로(path) 기준으로 동작한다.

| API                                            | 기능                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `mkdir`, `touch`, `mv`, `cp`, `rmdir`, `rm`    | 디렉터리·파일 조작                                            |
| `POST`/`GET content`, `GET download`           | 콘텐츠 업로드·다운로드(Range 지원)                            |
| `ls`, `stat`, `exists`, `find`                 | 조회(cursor 기반 페이지네이션)                                |
| `GET /api/v2/public/{ns}/fs/download\|content` | `accessPolicy=PUBLIC` namespace의 무인증 다운로드(Range 지원) |

공개 다운로드 규칙:

- `download`·`content` 라우트만 제공한다.
- 목록 조회·쓰기는 제공하지 않는다.
- `accessPolicy`는 namespace 생성 시 결정한다.
- 생성 후 `accessPolicy`는 변경할 수 없다.
- `ENCRYPTED` namespace는 `PUBLIC`으로 만들 수 없다.

인증된 파일 조작 API는 `api/v2/namespaces/:namespaceId/fs/*` 아래에 있다.
구현은 `apps/api/src/vfs/fs.controller.ts`에 있다.
호출 서버가 로컬 파일시스템처럼 Storix를 다루는 것이 설계 목표다.
전체 API 계약은 [OpenAPI](apps/api/openapi.yaml)를 따른다.
계약 확정 결정은 api ADR-0030을 따른다.

### namespace 한도 조회

서비스 API key로 `GET /api/v2/namespaces/{namespaceId}`를 호출해 적용 한도와 사용량을 조회한다.
namespace 생성·목록·관리 응답에도 같은 `limits`·`quota` 필드가 포함된다.
바이트 값은 바이트 단위 10진 문자열이다.

| 필드                                       | 의미                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `limits.maxFileSizeBytes`                  | 단일 파일 크기의 유효 상한                                                      |
| `limits.maxFilesPerFolder`                 | 폴더별 파일 수의 유효 상한                                                      |
| `limits.maxNodes`                          | namespace node 수의 유효 상한                                                   |
| `quota.limitBytes`                         | namespace quota의 적용 상한                                                     |
| `quota.usedBytes`                          | 제외 설정과 관계없이 live FILE·보존 snapshot·휴지통 FILE entry 크기를 더한 총량 |
| `quota.enforcedBytes`                      | `excludeTrash`·`excludeSnapshots`를 반영한 quota 검사 대상 사용량               |
| `liveBytes`, `trashBytes`, `snapshotBytes` | 구성요소별 사용량                                                               |
| `quota.trash.maxRetainedBytes`             | 휴지통을 quota에서 제외할 때 적용하는 보존 바이트 상한                          |
| `quota.trash.retainedNodeCount`            | 현재 보존 중인 휴지통 node 수                                                   |
| `quota.trash.maxRetainedNodes`             | 보존 휴지통 node 수의 적용 상한                                                 |

단일 파일 크기 상한:

- namespace override가 없으면 `STORIX_DEFAULT_FILE_SIZE_BYTES`를 쓴다.
- override는 `STORIX_MAX_FILE_SIZE_BYTES` ceiling으로 제한한다.
- 기본값과 ceiling의 내장값은 `5368709120`(5 GiB)이다.

휴지통 바이트 상한:

- 기본값은 namespace quota다.
- 상한을 넘으면 휴지통이 켜진 namespace의 삭제를 413 `VFS_TRASH_LIMIT_EXCEEDED`로 거부한다.
- 휴지통을 quota에 포함하면 별도 휴지통 바이트 상한은 적용하지 않는다.

### 삭제 복구

휴지통의 기본값은 OFF다.
OFF이면 manifest 없이 영구 삭제한다.
`trashEnabled=true`이면 삭제한 파일·디렉터리 subtree 전체를 휴지통 항목 하나로 30일간 보존한다.

| 작업           | API·응답                                            | 인증·필수 헤더                                    |
| -------------- | --------------------------------------------------- | ------------------------------------------------- |
| 삭제           | `/fs/rm`·`/fs/rmdir`의 204 응답에 `X-Trash-Id` 반환 | 서비스 key                                        |
| 조건부 삭제    | `kind: delete` 응답에 `trashId` 반환                | 서비스 key                                        |
| 휴지통 조회    | `GET /fs/trash`                                     | 서비스 key                                        |
| 복구           | `POST /fs/trash/{trashId}/restore`                  | 서비스 key, `Idempotency-Key`, `X-Mutation-Scope` |
| 직접 영구 삭제 | `POST /fs/trash/{trashId}/purge`                    | 별도 관리자 key                                   |

복구 규칙:

- 원래 경로 또는 `targetPath`로 복구한다.
- 원래 node ID를 되살린다.
- 새 revision을 발급한다.
- 이미 존재하는 목적지는 덮어쓰지 않는다.
- 만료 항목은 복구할 수 없다.

보존·quota 규칙:

- 기본 보존 상한은 namespace당 100000 node(`STORIX_MAX_RETAINED_TRASH_NODES`)다.
- 삭제 후 live byte를 trash byte로 옮긴다.
- 만료 후에도 GC purge가 완료될 때까지 `quota.usedBytes`에 포함한다.
- `excludeTrashFromQuota=true`이면 quota 검사에서 제외한다.
- GC는 DB 시각 기준으로 만료 항목을 배치 purge한다.
- 다른 live 파일·snapshot·휴지통이 공유하는 Blob은 보존한다.

운영 배포 DB migration·실제 백업 복원·외부 consumer 연동은 별도 검증 대상이다.

### namespace 변경 feed

`GET /api/v2/namespaces/{namespaceId}/fs/changes`는 ACTIVE namespace의 파일·디렉터리 변경을 반환한다.
서비스 Bearer key로 인증한다.
`change-feed` capability는 기본 비활성이다.

활성화 순서:

1. namespace를 생성한다.
2. `STORIX_VFS_CAPABILITIES_CONFIG_PATH`의 시작 JSON 설정에서 전역과 해당 namespace에 `change-feed`를 허용한다.
3. app을 재시작한다.

설정 예:

```json
{
  "globalAllowedCapabilities": ["change-feed"],
  "namespaceAllowedCapabilities": {
    "11111111-1111-4111-8111-111111111111": ["change-feed"]
  }
}
```

서비스 Bearer key로 `GET /api/v2/namespaces/{id}/capabilities`를 조회해 활성화를 확인한다.

- 비활성 feed 요청은 409 `VFS_FEATURE_DISABLED`를 반환한다.
- 일반 파일 API는 계속 사용할 수 있다.
- 최초 checkpoint 이후에는 capability를 꺼도 journal 기록을 이어간다.
- 재활성화 후 보존 기간 안의 cursor를 재사용할 수 있다.

전체 동기화 순서:

1. cursor 없이 feed를 호출한다.
2. 반환된 `nextCursor`를 보존한다.
3. 기존 `ls`로 전체 항목을 열거한다.
4. 보존한 cursor로 변경 페이지를 조회한다.

열거 중 `ls` cursor가 무효화되면 feed checkpoint를 유지한다.
열거는 처음부터 다시 한다.

이벤트 규칙:

- namespace 순서 번호의 오름차순으로 반환한다.
- 이벤트 종류는 `created`·`updated`·`moved`·`deleted`다.
- 이동 이벤트에는 이전 경로가 들어간다.
- 삭제 이벤트에는 마지막 경로가 들어간다.
- `operationId`·`operationIndex`·`operationCount`는 한 transaction의 이벤트를 식별한다.
- 페이지 경계가 한 transaction을 나눌 수 있다.

페이지 처리:

- `cursor`와 선택적 `limit`(기본 100, 최대 1000)으로 다음 페이지를 받는다.
- 변경 적용과 `nextCursor` 저장은 소비자 DB에서 원자적으로 처리한다.
- 재조회로 겹치는 이벤트는 `sequence`로 중복 제거한다.
- `hasMore`는 조회 시점에 다음 페이지가 있는지 나타낸다.
- 빈 페이지의 `nextCursor`로 계속 polling할 수 있다.
- cursor는 내부 값을 해석하지 않는 불투명 토큰이다.

| cursor 조건                            | 응답·처리                       |
| -------------------------------------- | ------------------------------- |
| 잘못된 값 또는 다른 namespace의 cursor | 400 `VFS_INVALID_CURSOR`        |
| 보존 경계 이전의 cursor                | 410 `VFS_CHANGE_CURSOR_EXPIRED` |

만료 cursor를 받으면 새 checkpoint를 얻고 전체 열거부터 다시 한다.

보존 설정:

- 기본 보존 기간은 30일(`STORIX_VFS_CHANGE_RETENTION_DAYS`)이다.
- GC는 DB 시각으로 오래된 이벤트를 정리한다.
- compose의 `gc` 서비스는 `.env`의 보존 기간 값을 전달한다.
- 변경한 값은 다음 GC 실행부터 적용된다.

실제 운영 활성화·특정 소비자 연동·production 복구는 검증하지 않았다.
상세 계약은 [설계 문서](docs/design/08-namespace-change-feed.md)와 [OpenAPI](apps/api/openapi.yaml)를 따른다.

### Blob-level Copy-on-Write

같은 namespace 안에서 `cp`는 파일 콘텐츠를 복사하지 않는다.

- 새 VFS Node는 원본과 같은 immutable Blob을 참조한다.
- Blob의 `reference_count`를 증가시킨다.
- 대용량 파일·디렉터리 recursive copy에 콘텐츠 복사 I/O가 들지 않는다.
- 한 Node에 내용을 쓰면 그 Node만 새 Blob으로 교체한다.
- 다른 참조자는 영향을 받지 않는다.
- 참조 카운트가 0이 되면 grace period 이후 GC가 회수한다.

배경:

- `apps/api/docs/adr/0003-file-copy-blob-level-cow.md`
- `apps/api/docs/adr/0006-gc-zero-since-grace-period.md`

## 설치

### 사전 준비

- 컨테이너 런타임 중 하나:
  - Docker Engine + Docker Compose v2(`docker compose` 플러그인).
  - Podman 4 이상 + podman-compose 1.x.
- git.
- Postgres와 S3 호환 스토리지(VersityGW/AWS S3 등).

Podman 3.x는 `depends_on`의 healthcheck 조건을 무시한다.
기동 순서는 보장되지 않는다.
DB·스토리지는 기존 서비스에 연결하거나 override 파일로 컨테이너를 함께 띄운다.

Postgres 백업·복구 이미지:

- `pg_dump` client major와 서버 major가 같아야 한다.
- 기본 client major는 17이다.
- Postgres 16 서버용 이미지는 `PG_CLIENT_MAJOR=16`으로 빌드한다.
- 버전별 검증 결과는 `docs/deployment/postgres-versions.md`에 있다.

compose 파일은 compose-spec 표준 문법(`profiles`, `depends_on.condition`, YAML 앵커)을 쓴다.
Docker·Podman에서 같은 파일·옵션을 사용한다.

이미지 사용 방식:

- `up --build`는 `apps/api/Dockerfile`로 소스 이미지를 빌드한다.
- 태그 릴리즈는 `ghcr.io/cp949/storix:vX.Y.Z` 사전 빌드 이미지도 제공한다.
- 현재 compose 구성은 사전 빌드 이미지를 직접 pull하도록 연결하지 않았다.
- 릴리즈 절차는 `docs/deployment/release.md`를 따른다.

### 소스 받기

```bash
git clone https://github.com/cp949/storix.git
cd storix
```

### `.env` 작성

```bash
cp .env.example .env
```

Postgres + S3 호환 스토리지 조합에서 채울 값:

| 값                                                                                                           | 내용                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `STORIX_API_KEY`                                                                                             | `openssl rand -hex 32` 출력. 비어 있으면 compose가 기동을 거부한다 |
| `STORIX_DB_HOST`, `STORIX_DB_USERNAME`, `STORIX_DB_PASSWORD`, `STORIX_DB_NAME`                               | Postgres 접속 정보                                                 |
| `STORIX_STORAGE_ENDPOINT`, `STORIX_STORAGE_ACCESS_KEY`, `STORIX_STORAGE_SECRET_KEY`, `STORIX_STORAGE_BUCKET` | 스토리지 접속 정보                                                 |

override 적용 시:

- `docker-compose.postgres.yml`은 컨테이너 쪽 DB host·port를 재정의한다.
- 스토리지 백엔드 override는 endpoint·port·ssl을 재정의한다.
- VersityGW override는 자격증명·버킷을 컨테이너 초기화에도 쓴다.

전체 목록·기본값은 [환경변수](#환경변수) 절, 각 값의 의미와 주의사항은
`.env.example` 주석에 있다.

### 백엔드 선택

base(`docker-compose.yml`) 구성:

- API 서버 `app`.
- 운영 잡 `migrate`·`gc`·`backup`·`restore`.

DB·스토리지는 `.env`의 접속 정보로 외부 서비스에 연결한다.
백엔드 설정 변경·컨테이너 추가에는 override 파일을 `-f`로 겹친다.

| 파일                           | 추가·재정의하는 것                                                      | 상세 절차                |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------ |
| `docker-compose.versitygw.yml` | VersityGW 컨테이너·버킷 초기화(목표 기본 백엔드, ADR-0003)              | `README.versitygw.md`    |
| `docker-compose.s3.yml`        | AWS S3 엔드포인트·TLS·path-style 고정(컨테이너 없음)                    | `README.s3.md`           |
| `docker-compose.postgres.yml`  | 개발·검증용 Postgres 컨테이너                                           | 위 세 문서의 "개발" 명령 |
| `docker-compose.sqlite.yml`    | 단일 프로세스용 SQLite 설정(named volume의 파일 사용, DB 컨테이너 없음) | `README.sqlite.md`       |

백엔드별 README의 내용:

- `.env` 설정·기동.
- 업로드·다운로드 curl 시퀀스.
- 운영 잡·문제 해결.

배치 결정 배경은 `docs/adr/0004-compose-file-layout.md`에 있다.

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

Podman(파일·옵션은 Docker와 같다):

```bash
podman-compose -f docker-compose.yml -f docker-compose.versitygw.yml up -d --build
podman-compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml up -d --build
podman-compose up -d --build
```

기동 순서:

1. 백엔드 컨테이너 healthcheck.
2. 버킷 초기화.
3. `migrate`(스키마 마이그레이션).
4. `app`.

`migrate`는 `app`의 의존성이다.
`up`마다 자동 실행한다.
`ps`의 `Exited (0)`은 정상 종료다.

`/health/ready`는 DB·스토리지 연결까지 검사한다:

```bash
until curl -sf http://localhost:3000/health/ready > /dev/null; do sleep 2; done && echo ready
```

namespace 생성부터 업로드·다운로드까지의 curl 시퀀스는 백엔드 README의
"동작 확인" 절에 있다.

### `-f` 나열 줄이기

- 원하는 override를 `docker-compose.override.yml`로 복사·수정한다.
  - 이 파일은 gitignore 대상이다.
  - docker compose·podman-compose는 `-f` 없이 `up`하면 자동 병합한다.
- `.env`에 `COMPOSE_FILE=docker-compose.yml:docker-compose.versitygw.yml`을 둔다.
  - `.env.example` 상단을 참고한다.
  - docker compose는 `.env`의 `COMPOSE_FILE`을 읽는다.
  - podman-compose는 쉘에서 `export COMPOSE_FILE=...`한다.

### Podman 주의

- podman-compose는 `.env`의 `COMPOSE_FILE`을 읽지 않는다.
- podman-compose 1.6.0 이하는 `depends_on.condition: service_completed_successfully`에서 종료 코드를 확인하지 않는다.
- `migrate`가 실패해도 `app`이 기동할 수 있다.
- `podman-compose ... ps`에서 `migrate`가 `Exited (0)`인지 확인한다.
- 관련 upstream 이슈는 `containers/podman-compose#1481`이다.

## 운영 잡

운영 잡 실행 방식:

- `migrate`는 `up`마다 자동 실행한다.
- `gc`·`backup`·`restore`는 profile로 명시적으로 실행한다.
- 배포에 쓴 `-f` 조합에 `--profile`을 더한다.
- 조합을 바꾸면 잡이 다른 DB·스토리지에 연결할 수 있다.

| profile = 서비스 | 하는 일                                                                                      | 상세                                                   |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `gc`             | Blob·orphan object·만료 feed 이벤트·종결 업로드 세션 staging 회수(조건은 아래 참조)          | `apps/api/docs/adr/0006-gc-zero-since-grace-period.md` |
| `backup`         | Postgres dump + 스토리지 버킷 미러를 `STORIX_BACKUP_DIR/<타임스탬프>/`에 저장                | `docs/deployment/backup-restore.md`                    |
| `restore`        | `STORIX_RESTORE_SOURCE_DIR` 백업 복구(기존 데이터가 있으면 `STORIX_RESTORE_FORCE=true` 필요) | `docs/deployment/backup-restore.md`                    |

```bash
C="-f docker-compose.yml -f docker-compose.versitygw.yml"   # 배포에 쓴 조합

docker compose $C --profile gc run --rm gc
docker compose $C --profile backup run --rm backup
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose $C --profile restore run --rm restore
```

GC 회수 대상:

- 참조가 0이 된 뒤 `STORIX_ORPHAN_GRACE_PERIOD`(기본 1일)를 넘긴 Blob.
- metadata 없는 orphan object.
- 강제 종료로 남은 미완료 multipart upload. 시작 뒤 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`와 `STORIX_ORPHAN_GRACE_PERIOD`(기본 합 2일)가 지난 것만 abort한다. 스토리지 계정에 `s3:ListBucketMultipartUploads`·`s3:AbortMultipartUpload` 권한이 필요하다.
- 변경 feed 보존 기간을 넘긴 이벤트.
- 종결된 재개 업로드 세션의 staging 조각.

`gc`는 주기적으로 실행한다.
실행하지 않으면 삭제·덮어쓰기로 참조가 끊긴 Blob이 스토리지에 남는다.

재개 업로드를 켠 배포:

- 완료·취소·만료된 세션의 조각은 GC 전까지 staging에 남는다.
- 남은 조각은 `maxStagedBytes`를 차지한다.
- 한도가 차면 새 조각 저장은 `413 VFS_UPLOAD_STAGING_LIMIT_EXCEEDED`로 실패한다.
- GC 실행 주기는 staging 한도를 채우는 데 걸리는 시간보다 짧게 잡는다.

Postgres에서는 `STORIX_GC_MIN_INTERVAL`(기본 3600초) 안의 재실행을 건너뛴다.
SQLite에서는 이 중복 실행 방지 기능을 적용하지 않는다.
호스트 crontab 예(매일 04:00, 저장소 경로 `/opt/storix`):

```cron
0 4 * * * cd /opt/storix && docker compose -f docker-compose.yml -f docker-compose.versitygw.yml --profile gc run --rm gc >> /var/log/storix-gc.log 2>&1
```

운영 스케줄:

- `backup`과 `gc`는 겹치지 않게 실행한다.
- 백업 주기·보존은 `docs/deployment/backup-restore.md`를 따른다.
- DB 공유 시 잡 실행 위치는 `docs/deployment/multi-instance-versitygw.md`를 따른다.

## 환경변수

Storix 환경변수는 `STORIX_` 접두어를 쓴다(ADR-0005).
값의 의미와 주의사항은 `.env.example` 주석에 있다.

| 구분   | 의미                                       |
| ------ | ------------------------------------------ |
| 필수   | 미설정이면 해당 프로세스가 부팅을 거부한다 |
| 조건부 | 지정한 조건에서 필수다                     |
| 선택   | 비우면 기본값을 쓴다                       |

| 읽는 곳 | 대상                             |
| ------- | -------------------------------- |
| 모두    | app·migrate·gc·backup·restore    |
| app·잡  | app·gc·backup·restore            |
| app·gc  | app·gc                           |
| compose | 코드가 읽지 않는 compose 보간 값 |

| 변수                                      | 구분   | 기본값                | 읽는 곳 | 용도                                                                                                                                                     |
| ----------------------------------------- | ------ | --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORIX_PUBLISH_HOST`                     | 선택   | `0.0.0.0`             | compose | `app` 컨테이너의 호스트 bind 주소                                                                                                                        |
| `STORIX_PUBLISH_PORT`                     | 선택   | `3000`                | compose | `app` 컨테이너를 호스트에 노출하는 포트                                                                                                                  |
| `STORIX_PORT`                             | 선택   | `3000`                | app     | app의 listen 포트                                                                                                                                        |
| `STORIX_DEFAULT_TOTAL_LOGICAL_BYTES`      | 선택   | `53687091200`         | app·gc  | Namespace quota override가 없을 때 적용하는 기본값(50 GiB)                                                                                               |
| `STORIX_MAX_TOTAL_LOGICAL_BYTES`          | 선택   | 기본값과 같음         | app·gc  | namespace quota override의 전역 ceiling                                                                                                                  |
| `STORIX_VFS_CAPABILITIES_CONFIG_PATH`     | 선택   | —                     | app     | 시작 시 읽는 선택 VFS capability JSON 파일 경로                                                                                                          |
| `STORIX_VFS_CHANGE_RETENTION_DAYS`        | 선택   | `30`                  | gc      | 변경 feed 이벤트 보존 기간(1~365000 일수)                                                                                                                |
| `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`  | 조건부 | —                     | app     | 재개 업로드 정책 JSON 경로                                                                                                                               |
| `STORIX_ADMIN_API_KEY`                    | 선택   | —                     | app     | `/api/v2/admin/*` 전용 관리자 Bearer key                                                                                                                 |
| `STORIX_ADMIN_API_KEY_PREVIOUS`           | 선택   | —                     | app     | 관리자 키 교체 기간에만 허용하는 이전 Bearer key                                                                                                         |
| `STORIX_DB_DRIVER`                        | 선택   | `postgres`            | 모두    | `postgres` 또는 `sqlite`. 그 외 값은 부팅을 거부                                                                                                         |
| `STORIX_DB_SQLITE_PATH`                   | 조건부 | —                     | 모두    | `STORIX_DB_DRIVER=sqlite`일 때 필수                                                                                                                      |
| `STORIX_DB_HOST`                          | 필수   | —                     | 모두    | Postgres 호스트                                                                                                                                          |
| `STORIX_DB_PORT`                          | 선택   | `5432`                | 모두    | Postgres 포트                                                                                                                                            |
| `STORIX_DB_USERNAME`                      | 필수   | —                     | 모두    | Postgres 사용자                                                                                                                                          |
| `STORIX_DB_PASSWORD`                      | 필수   | —                     | 모두    | Postgres 비밀번호                                                                                                                                        |
| `STORIX_DB_NAME`                          | 필수   | —                     | 모두    | 데이터베이스 이름                                                                                                                                        |
| `STORIX_STORAGE_ENDPOINT`                 | 필수   | —                     | app·잡  | S3 호환 엔드포인트 호스트                                                                                                                                |
| `STORIX_STORAGE_PORT`                     | 선택   | `9000`                | app·잡  | 스토리지 포트                                                                                                                                            |
| `STORIX_STORAGE_USE_SSL`                  | 선택   | `false`               | app·잡  | 스토리지 TLS 사용 여부                                                                                                                                   |
| `STORIX_STORAGE_ACCESS_KEY`               | 필수   | —                     | app·잡  | 스토리지 access key                                                                                                                                      |
| `STORIX_STORAGE_SECRET_KEY`               | 필수   | —                     | app·잡  | 스토리지 secret key                                                                                                                                      |
| `STORIX_STORAGE_BUCKET`                   | 필수   | —                     | app·잡  | 버킷 이름                                                                                                                                                |
| `STORIX_STORAGE_PATH_STYLE`               | 선택   | `true`                | app·잡  | path-style 주소 사용                                                                                                                                     |
| `STORIX_STORAGE_REGION`                   | 선택   | `us-east-1`           | app·잡  | 서명에 쓰는 리전                                                                                                                                         |
| `STORIX_STORAGE_SOCKET_TIMEOUT_MS`        | 선택   | `120000`              | app·잡  | 스토리지 소켓 무활동 상한(ms). 넘으면 요청을 끊고 503                                                                                                    |
| `STORIX_STORAGE_CONNECT_TIMEOUT_MS`       | 선택   | `10000`               | app·잡  | 스토리지 TCP 연결 수립 상한(ms). 연결 대기열 대기도 포함                                                                                                 |
| `STORIX_STORAGE_MAX_SOCKETS`              | 선택   | `50`                  | app·잡  | 스토리지 동시 연결 상한. 넘으면 다음 요청이 대기하다 503                                                                                                 |
| `STORIX_STORAGE_PUBLIC_ENDPOINT`          | 선택   | —                     | app     | presigned download URL의 외부 접근 주소                                                                                                                  |
| `STORIX_STORAGE_PUBLIC_PORT`              | 선택   | `9000`                | app     | 외부 접근 포트                                                                                                                                           |
| `STORIX_STORAGE_PUBLIC_USE_SSL`           | 선택   | `false`               | app     | 외부 접근 TLS 여부                                                                                                                                       |
| `STORIX_VERSITYGW_DATA_PATH`              | 선택   | —                     | compose | `docker-compose.versitygw.yml` 전용                                                                                                                      |
| `STORIX_NGINX_PUBLIC_PORT`                | 선택   | `8443`                | compose | `docs/deployment/compose.nginx-demo.yml` 전용 호스트 포트                                                                                                |
| `STORIX_SCENARIO_VERSITYGW_PORT`          | 선택   | `7070`                | compose | `co-located-nginx-mtls` 시나리오에서 host Nginx가 접근할 loopback 포트                                                                                   |
| `STORIX_SCENARIO_SECRETS_DIR`             | 선택   | `/etc/storix/secrets` | compose | `single-host-private` 시나리오의 비밀 파일 디렉터리                                                                                                      |
| `STORIX_DEFAULT_FILE_SIZE_BYTES`          | 선택   | `5368709120`          | app     | namespace 파일 크기 override가 없을 때 적용하는 기본값(5 GiB)                                                                                            |
| `STORIX_MAX_FILE_SIZE_BYTES`              | 선택   | 기본값과 같음         | app     | 단일 파일의 전역 ceiling                                                                                                                                 |
| `STORIX_DEFAULT_MAX_FILES_PER_FOLDER`     | 선택   | `10000`               | app     | 폴더의 직접 자식 FILE 기본 상한                                                                                                                          |
| `STORIX_MAX_FILES_PER_FOLDER`             | 선택   | 기본값과 같음         | app     | 폴더별 직접 자식 FILE 상한의 전역 ceiling                                                                                                                |
| `STORIX_DEFAULT_MAX_LIVE_NODES`           | 선택   | `1000000`             | app     | namespace의 root를 제외한 live FILE·DIRECTORY 기본 상한                                                                                                  |
| `STORIX_MAX_LIVE_NODES`                   | 선택   | 기본값과 같음         | app     | namespace live node 상한의 전역 ceiling                                                                                                                  |
| `STORIX_MAX_SYNC_DELETE_NODES`            | 선택   | `1000`                | app     | recursive rm이 동기 처리하는 노드 수 상한                                                                                                                |
| `STORIX_MAX_SYNC_COPY_NODES`              | 선택   | `1000`                | app     | recursive cp 노드 수 상한                                                                                                                                |
| `STORIX_MAX_SYNC_MOVE_NODES`              | 선택   | `10000`               | app     | mv가 동기 처리하는 subtree 노드 수 상한(이동 대상 자신 포함)                                                                                             |
| `STORIX_MAX_SYNC_SNAPSHOT_NODES`          | 선택   | `1000`                | app     | snapshot 한 건의 최대 manifest 노드 수(디렉터리 포함)                                                                                                    |
| `STORIX_MAX_SNAPSHOT_BYTES`               | 선택   | `5368709120`          | app     | snapshot 한 건의 논리적 파일 크기 합계 상한(5 GiB)                                                                                                       |
| `STORIX_MAX_RETAINED_SNAPSHOT_NODES`      | 선택   | `100000`              | app     | namespace 내 보존 중인 모든 snapshot의 manifest 노드 수 합계 상한                                                                                        |
| `STORIX_MAX_RETAINED_SNAPSHOT_BYTES`      | 선택   | `53687091200`         | app     | namespace 내 보존 중인 모든 snapshot의 논리적 파일 크기 합계 상한(50 GiB)                                                                                |
| `STORIX_MAX_RETAINED_TRASH_NODES`         | 선택   | `100000`              | app·gc  | namespace별 보존 휴지통 node 수 상한                                                                                                                     |
| `STORIX_MUTATION_LEASE_SECONDS`           | 선택   | `60`                  | app     | 조건부 업로드 claim lease(초, 최대 6442450)                                                                                                              |
| `STORIX_MUTATION_MAX_UPLOAD_SECONDS`      | 선택   | `86400`               | app·gc  | 조건부 raw 업로드와 재개 업로드 조각 요청의 최대 지속 시간(초, 기본 24시간, 최대 2147483). HTTP 서버의 요청 수신 상한(`requestTimeout`)도 이 값을 따른다 |
| `STORIX_SHUTDOWN_TIMEOUT_SECONDS`         | 선택   | `25`                  | app     | SIGTERM·SIGINT 뒤 진행 중 요청을 기다리는 최대 시간(초, 1~3600)                                                                                          |
| `STORIX_VFS_EXPIRY_MIN_SECONDS`           | 선택   | `60`                  | app     | 새 FILE 만료 입력의 최소 기간(초)                                                                                                                        |
| `STORIX_VFS_EXPIRY_MAX_SECONDS`           | 선택   | `2592000`             | app     | 새 FILE 만료 입력의 최대 기간(초)                                                                                                                        |
| `STORIX_PRESIGNED_URL_EXPIRY_SECONDS`     | 선택   | `300`                 | app     | presigned URL 만료(초)                                                                                                                                   |
| `STORIX_ORPHAN_GRACE_PERIOD`              | 선택   | `86400`               | gc      | 참조 0 이후 회수까지 유예(1~31536000000 초)                                                                                                              |
| `STORIX_GC_MIN_INTERVAL`                  | 선택   | `3600`                | gc      | 멀티 인스턴스에서 중복 실행을 막는 최소 재실행 간격(초)                                                                                                  |
| `STORIX_GC_MAX_ROWS_PER_STAGE`            | 선택   | `200000`              | gc      | 한 실행에서 단계마다 처리하는 행 수 예산                                                                                                                 |
| `STORIX_NAMESPACE_DELETED_RETENTION_DAYS` | 선택   | `30`                  | gc      | 삭제가 끝난(`DELETED`) namespace의 행을 gc가 물리 삭제하기까지의 보존 기간(1~365000일)                                                                   |
| `STORIX_API_KEY`                          | 필수   | —                     | app     | 서비스 간 인증 키                                                                                                                                        |
| `STORIX_API_KEY_PREVIOUS`                 | 선택   | —                     | app     | 키 로테이션 중 함께 유효한 이전 키                                                                                                                       |
| `STORIX_ENCRYPTION_MASTER_KEY`            | 조건부 | —                     | app     | ENCRYPTED namespace가 하나라도 있으면 필요한 키                                                                                                          |
| `STORIX_SENTRY_DSN`                       | 선택   | —                     | app·잡  | 설정 시 500 에러·잡 실패를 Sentry로 리포팅                                                                                                               |
| `STORIX_SECRET_ADAPTERS`                  | 선택   | —                     | 모두    | 쉼표로 구분한 통신형 비밀값 어댑터 패키지 이름                                                                                                           |
| `STORIX_SECRET_RESOLVE_TIMEOUT_MS`        | 선택   | `10000`               | 모두    | 통신형 비밀값 해석 1건의 타임아웃(ms)                                                                                                                    |
| `STORIX_BACKUP_DIR`                       | 필수   | —                     | backup  | 백업 저장 디렉터리                                                                                                                                       |
| `STORIX_RESTORE_SOURCE_DIR`               | 필수   | —                     | restore | 복구할 백업 디렉터리                                                                                                                                     |
| `STORIX_RESTORE_FORCE`                    | 선택   | `false`               | restore | 대상에 데이터가 있어도 덮어쓴다(되돌릴 수 없음)                                                                                                          |

### 환경변수 적용 규칙

- 포트·타임아웃·GC 주기·동기 처리 한도처럼 `parsePositiveInt`로 읽는 정수 변수는 앞자리 0이 없는 10진 숫자만 허용한다.
  - `1e3`, `0x10`, `+5`, `5.0`, 공백이 붙은 값, 안전 정수 범위를 넘는 값은 부팅을 거부한다.
  - 빈 값은 기본값을 쓴다.
- `STORIX_STORAGE_USE_SSL`, `STORIX_STORAGE_PATH_STYLE`, `STORIX_STORAGE_PUBLIC_USE_SSL`, `STORIX_RESTORE_FORCE`는 `true`·`false`만 허용한다(대소문자 무관).
  - `1`, `yes`, 공백이 붙은 값은 부팅(복구는 시작)을 거부한다. 오류 메시지에 변수 이름이 나온다.
  - 빈 값은 기본값을 쓴다.
- `STORIX_STORAGE_SOCKET_TIMEOUT_MS`, `STORIX_STORAGE_CONNECT_TIMEOUT_MS`는 양의 정수만 받고 상한은 2147483647이다.
  - `0`(무제한)은 거부한다. Node 타이머는 상한을 넘는 값을 1ms로 줄여 즉시 끊기 때문에 상한을 넘는 값도 거부한다.
  - 소켓 무활동 시간은 클라이언트가 다운로드 읽기를 완전히 멈춘 경우에도 흐른다. 이 경우 응답 헤더가 이미 나간 뒤라 연결이 중단된다.
  - 큰 object의 완료 처리나 대량 삭제처럼 백엔드가 응답 전에 오래 걸리는 호출이 있으면 소켓 무활동 상한을 늘린다.
- `STORIX_STORAGE_MAX_SOCKETS`는 1~65535의 양의 정수만 받는다.
  - 진행 중인 스토리지 요청마다 연결 하나를 쓴다. 장기 다운로드는 클라이언트가 다 받을 때까지 연결을 점유한다.
  - 상한에 닿으면 다음 요청이 연결을 기다리다 `STORIX_STORAGE_CONNECT_TIMEOUT_MS` 뒤 503으로 끝난다. `/health/ready`도 같은 연결을 쓰므로 함께 503이 될 수 있다.
  - 동시 다운로드·업로드가 50을 넘는 배포는 값을 늘린다. 스토리지 백엔드(VersityGW 등)의 동시 연결 한도는 별도로 확인한다.
- `STORIX_MAX_SYNC_SNAPSHOT_NODES`, `STORIX_MAX_RETAINED_SNAPSHOT_NODES`, `STORIX_MAX_SNAPSHOT_BYTES`, `STORIX_MAX_RETAINED_SNAPSHOT_BYTES`는 시작할 때 검증한다. 앞자리 0이 없는 양의 10진 정수가 아니면 시작을 거부하고 오류 메시지에 변수 이름이 나온다. 빈 값은 기본값이다.
- `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`, `STORIX_VFS_CHANGE_RETENTION_DAYS`는 다른 파서를 쓰고 빈 값도 거부한다. 두 변수와 `STORIX_ORPHAN_GRACE_PERIOD`는 약 1000년(365000일) 상한을 넘으면 시작을 거부한다. PostgreSQL은 그 이상에서 날짜 범위 오류가 나 GC 실행이 중간에 끝난다.
- `STORIX_PUBLISH_HOST`: host Nginx만 접근시키려면 `127.0.0.1`로 설정한다.
- `STORIX_PORT`:
  - 컨테이너 안은 3000으로 고정한다.
  - 호스트 직접 실행에서만 바꾼다.
  - 1~65535의 10진 정수만 받는다. `0`은 OS가 빈 포트를 배정한다. 그 밖의 값(`3000abc`, `0x1F90`, `65536`)은 부팅을 거부한다.
- `STORIX_MAX_TOTAL_LOGICAL_BYTES`:
  - 기본값 이상이어야 한다.
  - override는 ceiling 이하로 허용한다.
- `STORIX_VFS_CAPABILITIES_CONFIG_PATH`:
  - 비우면 선택 기능 전부 비활성.
  - 값은 컨테이너 안 파일 경로다. 기본 compose는 이 변수를 전달하지 않고 파일을 넣을 volume도 없다. override의 `environment:`와 `volumes:`에서 함께 지정한다(예: `docs/deployment/scenarios/demo-all-in-one/compose.resumable.yml`). 루트 `.env`에 적은 값은 호스트 직접 실행에서만 읽는다.
  - 허용 필드:
    - `globalAllowedCapabilities`: 문자열 목록.
    - `namespaceAllowedCapabilities`: namespace ID를 키로 하는 문자열 목록 객체.
    - `defaultEnabledCapabilities`: 개별 항목이 없는 namespace에 적용할 선택적 기본 활성 목록.
  - 파일·구문·schema·namespace 존재·미등록 capability 검증이 실패하면 시작을 거부한다.
  - `resumable-upload`·`change-feed`는 기본 비활성이다.
  - 활성 상태는 서비스 Bearer 인증으로 `GET /api/v2/namespaces/{id}/capabilities`에서 조회한다.
- `STORIX_VFS_CHANGE_RETENTION_DAYS`:
  - GC가 DB 시각으로 오래된 이벤트를 정리한다.
  - 정리 후 보존 경계를 전진시킨다.
  - 만료 cursor는 410과 전체 재동기화가 필요하다.
- `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`:
  - `resumable-upload`를 전역 또는 namespace에서 허용하면 필수다.
  - 전달 방식은 `STORIX_VFS_CAPABILITIES_CONFIG_PATH`와 같다. override에서 경로와 volume을 함께 지정한다.
  - 엄격한 schema·기본값·활성 순서는 아래 참고.
- `STORIX_ADMIN_API_KEY`:
  - 비우면 관리자 API는 모두 401.
  - 현재·이전 관리자 키 중 하나가 현재·이전 서비스 키(`STORIX_API_KEY`·`STORIX_API_KEY_PREVIOUS`) 중 하나와 같으면 부팅을 거부한다.
- `STORIX_DB_DRIVER`:
  - `sqlite`이면 `STORIX_DB_HOST` 등은 무시한다.
  - SQLite는 `STORIX_DB_SQLITE_PATH`만 사용한다.
  - SQLite는 단일 프로세스 all-in-one 배포를 전제로 한다.
  - compose에는 `docker-compose.sqlite.yml`을 겹친다.
  - 상세 제약은 `README.sqlite.md`를 따른다.
- `STORIX_DB_SQLITE_PATH`: sqlite 파일 경로.
- `STORIX_DB_HOST`: `docker-compose.postgres.yml`이 컨테이너 쪽을 `postgres`로 재정의.
- `STORIX_DB_PORT`: 1~65535. postgres override에서는 호스트 노출 포트로도 쓰인다.
- `STORIX_DB_USERNAME`: postgres override의 초기화 계정으로도 쓰인다.
- `STORIX_STORAGE_ENDPOINT`: 백엔드 override가 컨테이너 쪽을 재정의.
- `STORIX_STORAGE_PORT`: 1~65535. versitygw override는 `7070`으로 재정의.
- `STORIX_STORAGE_ACCESS_KEY`: versitygw override에서는 컨테이너 root 자격증명으로도 쓰인다.
- `STORIX_STORAGE_SECRET_KEY`: VersityGW 컨테이너 root 자격증명으로도 사용한다.
- `STORIX_STORAGE_BUCKET`: VersityGW override가 기동 시 생성한다.
- `STORIX_STORAGE_PATH_STYLE`: AWS S3는 `docker-compose.s3.yml`이 `false`로 고정.
- `STORIX_STORAGE_REGION`: 백엔드가 리전을 지정해 운영되면(VersityGW `--region`, AWS S3 버킷 리전) 같은 값을 넣는다.
- `STORIX_STORAGE_PUBLIC_ENDPOINT`:
  - 비우면 그 API만 실패한다.
  - gc·backup·restore는 presigned URL을 발급하지 않는다. 기본 compose는 `STORIX_STORAGE_PUBLIC_*`를 이 서비스들에 전달하지 않는다.
- `STORIX_VERSITYGW_DATA_PATH`: `/`로 시작하는 절대 경로면 bind mount, 비우면 named volume.
- `STORIX_MAX_FILE_SIZE_BYTES`: 기본값 이상, S3 multipart 구조상한 이하로 설정한다.
- `STORIX_MAX_RETAINED_TRASH_NODES`:
  - 양의 안전 정수만 허용한다.
  - 만료 뒤 GC purge 완료까지 보존 node 수에 포함한다.
- `STORIX_MUTATION_LEASE_SECONDS`: 업로드 중 이 시간의 1/3 간격으로 갱신. 최대 6442450(갱신 간격이 타이머 한도를 넘지 않는 값)이고 넘으면 부팅을 거부한다.
- `STORIX_MUTATION_MAX_UPLOAD_SECONDS`:
  - 최대 2147483(타이머 한도)이고 넘으면 부팅을 거부한다.
  - gc도 이 값을 읽어 미완료 multipart upload의 회수 시점을 정한다. app보다 작은 값을 gc에 주면 진행 중인 upload를 abort할 수 있으므로 같은 값을 준다.
  - HTTP 서버의 `requestTimeout`을 이 값(ms)으로 설정한다. Node 기본값(300초)이 남으면 느린 업로드가 이 값보다 먼저 408로 끊긴다. `headersTimeout`은 Node 기본값(60초)을 유지한다.
  - `requestTimeout`은 모든 라우트의 본문 수신에 적용된다. 업로드가 아닌 요청의 느린 본문 전송을 더 짧게 제한하려면 앞단 프록시에서 제한한다.
- `STORIX_VFS_EXPIRY_MIN_SECONDS`: 최대값 이하의 양의 안전 정수다.
- `STORIX_VFS_EXPIRY_MAX_SECONDS`:
  - 최소값 이상인 양의 안전 정수다.
  - PostgreSQL INTEGER 저장 범위에 따라 `2147483647`초 이하다.
- `STORIX_PRESIGNED_URL_EXPIRY_SECONDS`:
  - 상한은 `604800`(7일)이다.
  - 상한을 초과하면 부팅을 거부한다.
- `STORIX_GC_MIN_INTERVAL`: Postgres advisory lock과 이 간격으로 중복 실행을 막는다.
- `STORIX_GC_MAX_ROWS_PER_STAGE`:
  - 예산을 소진한 단계는 재개 위치를 저장한다.
  - 다음 실행이 저장된 위치에서 이어간다.
  - 단위는 단계가 정한다(change feed 정리는 읽은 만료 이벤트 수).
- `STORIX_NAMESPACE_DELETED_RETENTION_DAYS`:
  - 이 기간 동안만 삭제 상태 조회와 같은 key의 삭제 재요청 재생이 된다.
  - 물리 삭제는 되돌릴 수 없다.
  - capability 설정(`STORIX_VFS_CAPABILITIES_CONFIG_PATH`)에 남은 namespace가 물리 삭제되면 시작을 거부한다.
  - 물리 삭제한 namespace는 capability 설정에서도 지운다.
- `STORIX_API_KEY`: 공백만 있어도 거부.
- `STORIX_ENCRYPTION_MASTER_KEY`:
  - 64자 hex를 사용한다.
  - 분실하면 복호화할 수 없다.
- `STORIX_BACKUP_DIR`: compose 실행에서는 `/backups`(호스트 `./backups`)가 기본.
- `STORIX_RESTORE_SOURCE_DIR`: 빈 문자열도 거부.

### 비밀값 전달 방식

대상 변수 10개는 환경변수 외에 파일이나 통신형 어댑터로 받을 수 있다.

- `STORIX_API_KEY`, `STORIX_API_KEY_PREVIOUS`
- `STORIX_ADMIN_API_KEY`, `STORIX_ADMIN_API_KEY_PREVIOUS`
- `STORIX_ENCRYPTION_MASTER_KEY`
- `STORIX_STORAGE_ACCESS_KEY`, `STORIX_STORAGE_SECRET_KEY`
- `STORIX_DB_USERNAME`, `STORIX_DB_PASSWORD`
- `STORIX_SENTRY_DSN`

변수마다 한 방식만 쓴다.

기본 `docker-compose.yml`은 `STORIX_DB_USERNAME`·`STORIX_DB_PASSWORD`·`STORIX_STORAGE_ACCESS_KEY`·`STORIX_STORAGE_SECRET_KEY`에 기본값을 넣는다. 이 변수를 `_FILE`로 주려면 override에서 `<변수>: ""`로 비워야 한다. 비우지 않으면 환경변수와 파일이 함께 지정되어 기동이 실패한다.

| 방식     | 지정               | 값을 얻는 곳                                           |
| -------- | ------------------ | ------------------------------------------------------ |
| 환경변수 | `<비밀 변수>`      | 환경변수 값                                            |
| 파일     | `<비밀 변수>_FILE` | 지정한 경로의 파일 내용                                |
| 통신     | `<비밀 변수>_REF`  | `<scheme>://<참조>`의 scheme이 고른 어댑터가 돌려준 값 |

규칙:

- 빈 문자열은 지정하지 않은 것으로 본다. `.env`의 빈 `STORIX_API_KEY=` 줄은 충돌을 일으키지 않는다.
- 빈 값이 아닌 방식이 둘 이상이면 기동이 실패한다.
- `.env`에 적은 값은 `app`, `gc`, `backup`, `restore`가 해석한다. `migrate`와 `migration:run`(`typeorm` CLI)은 `.env`를 읽지 않으므로 셸·컨테이너 환경변수만 해석한다.
- 파일 값은 끝의 줄바꿈 하나만 제거한다.
- 해석에 실패하면 변수명, 방식, 실패 종류만 출력하고 기동이 실패한다. 값은 출력하지 않는다.
- 값은 기동 시 한 번 읽는다. 값을 바꾸면 재시작한다.

통신형:

- 어댑터 패키지를 설치한 사용자 이미지가 필요하다. 기본 이미지에는 어댑터가 없다.
- `STORIX_SECRET_ADAPTERS`에 어댑터 패키지 이름을 지정한다.
- 해석 1건의 타임아웃은 `STORIX_SECRET_RESOLVE_TIMEOUT_MS`다. 1~2147483647 ms를 허용하고 넘으면 부팅을 거부한다.
- 기본 `docker-compose.yml`은 `<비밀 변수>_REF`와 이 두 변수를 컨테이너에 넘기지 않는다. 루트 `.env`에 적어도 무시된다. override의 `environment:`에 직접 적는다.

compose에서 파일로 전달하는 절차는 [단일 호스트 private 배포](docs/deployment/scenarios/single-host-private/README.md)의 "비밀값 파일 전달"을 따른다.
규칙의 상세는 `docs/design/15-secret-sources.md`다.

AWS Secrets Manager 어댑터 사용자 이미지와 LocalStack 실행 예제는 [LocalStack 예제](docs/deployment/scenarios/aws-secrets-localstack/README.md)를 따른다. 실제 AWS 역할·IAM·KMS 설정 예시는 [AWS Secrets Manager 가이드](docs/guides/aws-secrets-manager-secret-source.md)에 있다.

### 재개 업로드 활성화

`resumable-upload`는 기본 비활성이다.

활성화 순서:

1. 대상 namespace를 생성한다.
2. Capability 파일과 세션 정책 파일을 준비한다.
3. `STORIX_VFS_CAPABILITIES_CONFIG_PATH`와 `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`를 설정한다.
4. app을 재시작한다.
5. 서비스 Bearer 인증으로 `GET /api/v2/namespaces/{id}/capabilities`를 조회한다.

두 파일은 시작 시 한 번만 읽는다.
아래 UUID·한도는 **예시**다.
실제 용량·동시 요청 수에 맞게 설정한다.

Capability 파일:

```json
{
  "globalAllowedCapabilities": ["resumable-upload"],
  "namespaceAllowedCapabilities": {
    "11111111-1111-4111-8111-111111111111": ["resumable-upload"]
  }
}
```

회원마다 namespace를 만드는 배포는 `defaultEnabledCapabilities`를 사용한다.
새 namespace에도 재시작 없이 적용한다.

- `namespaceAllowedCapabilities`에 항목이 있으면 기본 목록 대신 해당 값을 쓴다.
- 빈 목록은 비활성이다.
- 전역 허용 목록이 최종 상한이다.

설정 예:

```json
{
  "globalAllowedCapabilities": ["resumable-upload"],
  "namespaceAllowedCapabilities": {},
  "defaultEnabledCapabilities": ["resumable-upload"]
}
```

세션 정책 파일(`namespaces` 객체는 필수이며 namespace별 override 항목은 선택이다):

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

세션 정책 schema:

- 최상위 필드는 `global`·`namespaces`만 허용한다.
- 두 필드는 모두 필수다.
- namespace override가 없으면 `global` 한도를 쓴다.
- namespace별 두 필수 한도는 각각 해당 전역 한도 이하여야 한다.
- namespace 항목은 선택 필드 `partSizeBytes`(2147483647 bytes 이하의 양의 안전한 정수)를 가질 수 있다. 전역 값보다 커도 되고, 없으면 `global.partSizeBytes`를 쓴다. 세션 생성 시점의 값으로 고정한다.
- 조각 크기와 staging 한도의 시작 검증은 [재개 업로드 설계의 설정과 만료](docs/design/07-resumable-upload.md#설정과-만료)를 따른다.
- Namespace ID는 원래 표기를 쓴다.
- 대소문자·하이픈 변형은 정규화하지 않는다.
- 추가 필드·잘못된 ID·잘못된 값은 시작 오류다.

| `global` 필드        | 필수 여부 | 기본값         | 조건                                         |
| -------------------- | --------- | -------------- | -------------------------------------------- |
| `maxStagedBytes`     | 필수      | —              | signed int64 이하의 양의 10진 문자열         |
| `maxActiveSessions`  | 필수      | —              | 양의 안전한 정수                             |
| `partSizeBytes`      | 선택      | 16777216 bytes | 2147483647 bytes 이하의 양의 안전한 정수     |
| `inactivitySeconds`  | 선택      | 86400초        | `maxLifetimeSeconds` 이하의 양의 안전한 정수 |
| `maxLifetimeSeconds` | 선택      | 604800초       | 양의 안전한 정수                             |

시작 오류에 표시된 조각 크기를 낮추거나 정책상 허용할 수 있는 staging 한도를 높인다. namespace 한도를 높일 때는 전역 상한도 확인한다.

요청·정리 규칙:

- 파일 전체에는 namespace의 유효 파일 크기 상한을 적용한다.
- default·ceiling·override 해석은 [Namespace 제한과 설정](docs/design/14-namespace-limits-and-counters.md)의 "상한 해석"을 따른다.
- 각 조각 요청에는 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`(기본 86400초)를 적용한다.
- capability를 끈 뒤에도 세션 조회·취소·완전 업로드된 세션 완료·GC 정리는 가능하다.
- GC는 세션 만료·객체 삭제·30일 경과 세션 정리를 수행한다.
- 배포에서 GC 실행을 유지한다.

상세 API 계약은 `apps/api/openapi.yaml`과 `docs/design/07-resumable-upload.md`를 따른다.

### 불변 VFS snapshot

`/api/v2/namespaces/{namespaceId}/fs/snapshots`에서 불변 manifest를 만든다.

| 종류 | 대상               | 지원 기능                                              |
| ---- | ------------------ | ------------------------------------------------------ |
| FILE | 현재 파일          | 고정 binary bytes·MIME 조회, revision 조건부 파일 복원 |
| TREE | 디렉터리 하위 트리 | manifest 목록·파일별 내용 조회                         |

snapshot 규칙:

- TREE 전체 복원은 제공하지 않는다.
- snapshot ID는 현재 VFS 경로의 revision과 별개다.
- 원본 파일 변경·삭제 후에도 snapshot 내용을 읽을 수 있다.

한도 계산:

- 작업당 한도는 snapshot 하나의 manifest 항목 수(디렉터리 포함)와 파일 크기의 논리적 합계에 적용한다.
- 보존 총량은 namespace의 모든 snapshot에 같은 방식으로 적용한다.
- 같은 Blob이 여러 항목에 나타나면 항목마다 계산한다.
- namespace별 snapshot 한도는 전역 한도보다 낮게만 재정의한다.

삭제·GC:

- snapshot은 자동 만료되지 않는다.
- `POST .../snapshots/{snapshotId}/delete`로 명시적으로 삭제한다.
- 삭제하면 보존 예산과 Blob 참조가 해제된다.
- 보존 중인 snapshot이 참조하는 Blob은 원본 파일을 삭제해도 GC가 회수하지 않는다.

백업·복구:

- snapshot 복구·마이그레이션 롤백에는 DB metadata·manifest와 Blob 오브젝트의 **같은 시점** 백업이 필요하다.
- 운영 백업 중에는 쓰기와 GC를 멈춘다.
- 백업 잡은 쓰기를 자동 중지하지 않는다.
- DB 마이그레이션의 `down()`만 실행하면 이후 생성된 snapshot 데이터는 보존되지 않는다.
- 절차는 `docs/deployment/backup-restore.md`를 따른다.

## 개발

호스트 실행 요구사항:

- Node.js `>=24.18`.
- pnpm 11(`corepack enable`).

호스트 실행 시 `.env`를 쉘로 내보낸다.

- `migrate`는 `.env` 파일을 읽지 않는다.
- app은 실행 디렉터리(`apps/api`)의 `.env`만 읽는다.

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
- AWS Secrets Manager 비밀값 전달: [LocalStack 실행 예제](docs/deployment/scenarios/aws-secrets-localstack/README.md), [AWS 운영 설정 가이드](docs/guides/aws-secrets-manager-secret-source.md)
- 에이전트·기여자 규약: `AGENTS.md`, `docs/agents/`
- 상용화 로드맵: `docs/ROADMAP.md`
- 변경 이력: `CHANGELOG.md`
