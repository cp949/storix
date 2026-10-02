# VersityGW 멀티 인스턴스 배포 (공유 DB + NAS 기반 전용 스토리지)

ADR-0003의 목표 배치는 여러 Storix WAS(API 서버)가 하나의 Postgres DB를 공유하는 구성이다.
NAS 기반 배포에서는 WAS마다 VersityGW를 1:1로 배치한다.
이 문서는 Compose 조합과 운영 규칙을 다룬다.

- 토폴로지 결정: [ADR-0003](../adr/0003-versitygw-primary-backend-and-topology.md).
- Compose 파일 배치: [ADR-0004](../adr/0004-compose-file-layout.md).
- 실제 NAS의 동시 접근은 아래 미검증 경계를 따른다.

## 사용법

각 WAS 호스트의 `.env`에 공유 DB 접속 정보와 NAS 경로를 설정한다.

```bash
STORIX_DB_HOST=<전용 Postgres 호스트>
STORIX_DB_PORT=5432
STORIX_DB_USERNAME=<공유 DB 계정>
STORIX_DB_PASSWORD=<공유 DB 비밀번호>
STORIX_DB_NAME=<공유 DB 이름>
STORIX_VERSITYGW_DATA_PATH=/mnt/nas/storix-data
```

base와 VersityGW override로 기동한다.

```bash
docker compose -f docker-compose.yml -f docker-compose.versitygw.yml up -d
```

Compose·환경 변수 규칙:

- `docker-compose.postgres.yml`은 함께 사용하지 않는다.
- 이 override는 로컬 Postgres를 추가하고 모든 서비스의 `STORIX_DB_HOST`를 재정의한다.
- 공유 DB 배포와 충돌한다.
- `.env` 대신 shell에서 값을 export할 수 있다.
- shell 환경 변수는 `.env`보다 우선한다.

미설정 동작:

- `STORIX_DB_HOST`가 비어 있어도 Compose 파싱은 통과한다.
- `migrate`·`app`은 부팅 시 실패한다.
- `${VAR:?}`를 쓰지 않는 이유는 `docker-compose.yml` 상단 주석을 따른다.
- `STORIX_VERSITYGW_DATA_PATH`가 비어 있으면 `versitygw-data` named volume을 쓴다.
- 이 경우 NAS 공유 대신 단일 인스턴스와 같은 로컬 저장 구성이 된다.

### STORIX_VERSITYGW_DATA_PATH는 WAS 호스트마다 달라지는 값이 아니다

경로 규칙:

- 모든 WAS 호스트는 동일한 NAS 경로를 사용한다.
- 공유 대상은 NAS 데이터다.
- 각 WAS는 그 경로를 보는 전용 VersityGW 컨테이너를 사용한다(ADR-0003).
- 호스트별 하위 경로(`/mnt/nas/was-01`, `/mnt/nas/was-02`)를 사용하지 않는다.
- 경로가 다르면 공유 DB의 object를 다른 WAS에서 읽지 못한다.
- 같은 DB를 사용하는 backup·restore·GC에도 이 불일치가 적용된다.

`STORIX_VERSITYGW_DATA_PATH`는 `/`로 시작하는 절대 경로다.
`mnt/nas/storix-data`처럼 선행 `/`를 빠뜨리지 않는다.
bind mount 대신 named volume으로 해석되는 경로를 피한다.

미검증 경계:

- 여러 VersityGW posix 백엔드의 동일 NAS 동시 접근은 검증하지 않았다.
- 다중 프로세스 파일 접근·잠금의 안전성은 실 배포 전에 검증한다(ADR-0003 Consequences).

## 운영 규칙 — 마이그레이션 동시 실행 금지

- `docker compose up`은 `migrate`를 실행한다.
- 적용할 migration이 없으면 종료한다.
- TypeORM migration runner에는 분산 락이 없다.
- 여러 호스트가 같은 미적용 migration을 동시에 실행할 수 있다.
- Compose는 호스트 간 실행 순서를 조율하지 않는다.

새 migration이 포함된 배포 순서:

1. 한 WAS 호스트를 갱신한다.
2. 해당 호스트의 `migrate` 성공과 기동 완료를 확인한다.
3. 다음 WAS 호스트를 갱신한다.

동시에 재기동하지 않는다.
구버전·신버전 혼합 실행 가능 여부는 버전별 migration 계약을 확인한다.
순차 기동만으로 스키마 호환성을 보장하지 않는다.

## 운영 규칙 — backup/restore는 함대당 한 곳에서만 실행, gc는 자체 방지

`migrate`·`app`·`backup`·`restore`·`gc`는 `.env`의 `STORIX_DB_HOST`를 사용한다.
모든 호스트가 같은 Postgres를 대상으로 동작한다.

| 작업               | 실행 규칙                                          |
| ------------------ | -------------------------------------------------- |
| `backup`·`restore` | 한 WAS 호스트 또는 전용 운영 호스트에서만 실행한다 |
| `backup`           | 모든 API 쓰기와 GC를 중단한 뒤 실행한다            |
| `restore`          | 모든 WAS와 GC를 정지한 뒤 실행한다                 |
| `gc`               | Postgres의 중복 실행 방지를 사용한다               |

- 여러 WAS에서 backup·restore를 동시에 실행하는 구성은 지원하지 않는다.
- `STORIX_RESTORE_FORCE=true`는 공유 DB와 스토리지 데이터를 교체한다.
- 복구 영향은 명령을 실행한 호스트에 한정되지 않는다.
- 백업·복구 절차와 위험도·롤백 조건은 [백업/복구 운영 절차](./backup-restore.md)를 따른다.

GC 실행:

- Postgres advisory lock으로 동시 실행을 막는다.
- `STORIX_GC_MIN_INTERVAL`의 기본값은 3600초다.
- 다른 인스턴스가 실행 중이거나 최소 간격 안에 완료했으면 건너뛴다.
- 여러 WAS 호스트에 같은 스케줄을 설정할 수 있다.
- 잡 설정은 [README.versitygw](../../README.versitygw.md)의 "운영 잡"을 따른다.

## 스코프 밖

- NAS가 아닌 스토리지의 active/standby 구성. 방향만 ADR-0003에 기록한다.
- Postgres 자체의 HA·백업. 전용 호스트 운영자 책임이다.
- 실제 NAS·전용 DB 호스트의 smoke test. 로컬·CI는 이 구성을 재현하지 않는다.

실 배포 전에는 별도 호스트와 NAS 마운트에서 수동 검증한다.
