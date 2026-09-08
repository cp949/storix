# Storix

Storix는 호출 서버가 사용하는 독립 VFS(Virtual File System) 저장 서버다.
파일의 업무적 의미와 최종 사용자 인증·권한 판단은 호출 서버의 책임이며 Storix
도메인에 포함하지 않는다.

## 핵심 기능

### 파일시스템식 API

Storage key나 object ID가 아니라 경로(path) 기준으로 동작한다.

- `mkdir`, `touch`, `mv`, `cp`, `rmdir`, `rm` — 디렉터리/파일 조작
- `PUT`/`GET content`, `GET download` — 콘텐츠 업로드/다운로드(Range 지원)
- `ls`, `stat`, `exists`, `find` — 조회, cursor 기반 페이지네이션

전체 엔드포인트는 `api/v1/namespaces/:namespaceId/fs/*` 아래에 있다
(`src/vfs/fs.controller.ts`). 호출 서버가 로컬 파일시스템을 다루듯 Storix를
다룰 수 있게 하는 것이 설계 목표다.

### Blob-level Copy-on-Write

같은 namespace 안에서 `cp`는 파일 콘텐츠를 복사하지 않는다. 새 VFS Node가
원본과 같은 immutable Blob을 참조하며 `reference_count`만 증가시킨다.
대용량 파일이나 디렉터리 recursive copy가 MinIO I/O 없이 즉시 끝난다. 이후
어느 한쪽 Node에 내용을 쓰면 그 Node만 새 Blob으로 교체되고 다른 참조자는
영향받지 않는다. 참조 카운트가 0이 되면 grace period 이후 GC가 회수한다.

자세한 배경: `apps/api/docs/adr/0003-file-copy-blob-level-cow.md`,
`apps/api/docs/adr/0006-gc-zero-since-grace-period.md`.

## 실행 (Docker Compose)

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
복사·붙여넣기로 따라갈 수 있게 자기완결로 쓰여 있다.

개발·검증용 nginx reverse-proxy 샘플은 Storix 필수 구성이 아니라 루트가 아닌
`docs/deployment/compose.nginx-demo.yml`에 있다(`docs/deployment/nginx-reverse-proxy.md`).

```bash
cp .env.example .env   # STORIX_API_KEY(openssl rand -hex 32) 등을 채운다

# 운영: VersityGW + 외부 Postgres(.env의 STORIX_DB_HOST)
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml up -d
# 개발: 위 + 로컬 Postgres
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml -f docker-compose.postgres.yml up -d
# 외부 DB + 외부 S3 호환 스토리지: 접속 정보만
docker compose up -d
```

`-f` 나열을 줄이려면 원하는 override를 `docker-compose.override.yml`로 복사·수정하거나
(gitignore됨, `docker compose up`만으로 자동 병합), `.env`의 `COMPOSE_FILE`을 쓴다
(`.env.example` 상단 참고). Podman은 `docker compose`를 `podman-compose`로 바꾸면
된다 — 단, podman-compose는 `.env`의 `COMPOSE_FILE`을 읽지 않으므로 쉘에서 export한다.

운영 잡은 같은 `-f` 조합에 profile을 더해 실행한다(`docs/deployment/backup-restore.md`):

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml --profile backup run --rm backup
```

배치 결정 배경: `docs/adr/0004-compose-file-layout.md`.

## 문서

- 컨텍스트 목록: `CONTEXT-MAP.md`
- api 도메인 용어: `apps/api/CONTEXT.md`
- 시스템 전역 아키텍처 결정: `docs/adr/`, api 컨텍스트 결정: `apps/api/docs/adr/`
- 배포/운영 절차(reverse-proxy, 백업/복구 등): `docs/deployment/`
- 상용화 로드맵: `docs/ROADMAP.md`
