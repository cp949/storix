# VersityGW 멀티 인스턴스 배포 (공유 DB + NAS 기반 전용 스토리지)

ADR-0003이 확정한 목표 배포 형태: 여러 Storix WAS(API 서버) 인스턴스가
Postgres DB는 공유하고, NAS 기반 스토리지일 때는 WAS별로 VersityGW를
1:1 전용 배치한다. 이 문서는 그 배치를 위한 override 파일 사용법과
지켜야 할 운영 규칙을 다룬다. 배경은
`../adr/0003-versitygw-primary-backend-and-topology.md` 참고.

## 사용법

각 WAS 호스트에서:

```bash
export SHARED_DB_HOST=<전용 Postgres 호스트>
export VERSITYGW_DATA_PATH=/mnt/nas/storix-data
docker compose -f docker-compose.yml -f docker-compose.versity-demo.yml -f docker-compose.shared-db.yml up
```

`SHARED_DB_HOST`/`VERSITYGW_DATA_PATH`는 위처럼 shell에서 export하는
대신 다른 변수들처럼 `.env`에 넣어도 동일하게 동작한다 — shell 환경
변수는 `.env` 값보다 우선순위가 높을 뿐이다.

로컬 `postgres`/`minio` 컨테이너는 지금처럼 같이 뜨지만 쓰이지 않는다 —
정리는 스코프 밖이다(`docker-compose.versity-demo.yml`/
`docker-compose.s3-demo.yml`과 같은 선례).

`SHARED_DB_HOST`를 비워두면 `docker-compose.shared-db.yml`이 즉시
실패한다(값이 필수임을 명시적으로 강제). 이 required-마커는 `up`뿐
아니라 `down`/`logs`/`ps` 등 compose의 다른 모든 하위 명령에도 똑같이
적용된다 — teardown이나 상태 확인을 할 때도 같은 `-f` 파일들과
`SHARED_DB_HOST`를 그대로 넘겨야 한다. `VERSITYGW_DATA_PATH`를
비워두면 named volume(`versitygw-data`)을 쓰는 기존 단일 인스턴스
데모와 동일하게 동작한다.

공유 DB의 포트는 표준 포트(5432)만 지원한다. 접속 계정은
`docker-compose.shared-db.yml`이 아니라 `.env`의 기존
`DB_USERNAME`/`DB_PASSWORD`/`DB_NAME`에 넣는다.

### VERSITYGW_DATA_PATH는 WAS 호스트마다 달라지는 값이 아니다

`VERSITYGW_DATA_PATH`는 **모든 WAS 호스트에서 동일한 NAS 경로**를
가리켜야 한다 — 이 경로 자체는 공유 데이터이고, WAS별로 다른 건 그
경로를 바라보는 VersityGW 게이트웨이 컨테이너뿐이다(ADR-0003 결정 3,
Consequences 참고). 호스트마다 다른 하위 경로(예: `/mnt/nas/was-01`,
`/mnt/nas/was-02`)를 주면 안 된다 — 공유 Postgres DB의 메타데이터는
모든 호스트에 공통이므로, 한 호스트의 VersityGW로 쓴 오브젝트가 다른
호스트의 VersityGW 경로에서는 아예 안 보이는 불일치가 생기고, 이는
공유 DB를 대상으로 동작하는 backup/restore/gc(아래 절 참고)에도 그대로
영향을 준다.

`VERSITYGW_DATA_PATH`는 반드시 `/`로 시작하는 절대 경로여야 한다.
Docker Compose는 값이 절대 경로가 아니면 bind mount가 아니라 named
volume 이름으로 조용히 해석한다 — 예를 들어 맨 앞의 `/`를 빠뜨린
`mnt/nas/storix-data` 같은 오타는 에러 없이 로컬 named volume을 새로
만드는 것으로 조용히 실패한다.

**주의 — 미검증 위험**: 여러 VersityGW 인스턴스가 같은 NAS 마운트를
posix 백엔드로 동시에 바라보는 구성에서, VersityGW의 posix 백엔드
구현이 다중 프로세스의 동시 파일시스템 접근(락킹 등)을 안전하게
처리하는지는 아직 검증되지 않았다(ADR-0003 Consequences). 실 배포
전에 별도 검증이 필요한 열린 위험이다.

## 운영 규칙 — 마이그레이션 동시 실행 금지

`migrate`는 서비스 컨테이너라 `docker compose up`을 실행할 때마다 매번
새로 실행된다. 평소엔(적용할 마이그레이션이 없음) 즉시 종료돼 무해하다.

**새 마이그레이션이 포함된 배포를 여러 WAS 호스트에 동시에 롤아웃하면
위험하다** — TypeORM 마이그레이션 러너에 분산 락이 없어, 두 호스트가
동시에 "이 마이그레이션 미적용"을 보고 동시 실행을 시도하는 경쟁
상태가 생길 수 있다. compose는 호스트를 넘나드는 조율을 할 수
없으므로(각 호스트가 독립적으로 `docker compose up`을 실행), 아래
규칙을 반드시 지킨다:

> 새 마이그레이션이 포함된 배포는 WAS 호스트를 순차적으로 하나씩
> 재기동한다. 동시 재기동 금지 — 첫 호스트가 완전히 기동(`migrate`
> 완료)한 뒤에 다음 호스트를 재기동한다.

## 운영 규칙 — backup/restore/gc는 함대당 한 곳에서만 실행

`docker-compose.shared-db.yml`은 `migrate`/`app`뿐 아니라
`backup`/`restore`/`gc`의 `DB_HOST`도 공유 DB로 재정의한다. 즉 이
잡들은 이제 특정 WAS 호스트 로컬 DB가 아니라 **함대 전체가 공유하는
하나의 Postgres**를 대상으로 동작한다.

- `backup`/`gc`/`restore`는 함대 중 오직 한 호스트(또는 별도 전용
  운영 호스트)에서만 실행한다. 여러 WAS 호스트에서 동시에 실행하는
  시나리오는 분석·지원되지 않는다.
- `restore`(특히 `RESTORE_FORCE=true`)는 그것을 실행한 호스트만이
  아니라 **함대 전체가 공유하는 DB의 메타데이터를 통째로 리셋**한다.
  반드시 함대의 모든 WAS 인스턴스가 정지된 상태에서만 실행한다.

## 스코프 밖

- NAS가 아닌 스토리지에서의 active/standby 구성 — ADR-0003에 방향만
  기록, 아직 구현 안 됨.
- Postgres 자체의 HA/백업 — 전용 호스트 운영자 책임.
- 실 NAS/전용 DB 호스트에서의 스모크 테스트 — 이 저장소의 로컬 환경과
  CI에서는 재현 불가능하다(진짜 별도 호스트·NAS 마운트 필요). 위
  명령을 처음 실 배포에 적용하기 전에 반드시 실제 환경에서 최소 1회
  수동 검증한다.
