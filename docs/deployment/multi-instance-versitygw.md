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
export VERSITYGW_DATA_PATH=/mnt/nas/<이 WAS 전용 경로>
docker compose -f docker-compose.yml -f docker-compose.versity-demo.yml -f docker-compose.shared-db.yml up
```

로컬 `postgres`/`minio` 컨테이너는 지금처럼 같이 뜨지만 쓰이지 않는다 —
정리는 스코프 밖이다(`docker-compose.versity-demo.yml`/
`docker-compose.s3-demo.yml`과 같은 선례).

`SHARED_DB_HOST`를 비워두면 `docker-compose.shared-db.yml`이 즉시
실패한다(값이 필수임을 명시적으로 강제). `VERSITYGW_DATA_PATH`를
비워두면 named volume(`versitygw-data`)을 쓰는 기존 단일 인스턴스
데모와 동일하게 동작한다.

공유 DB의 포트는 표준 포트(5432)만 지원한다. 접속 계정은
`docker-compose.shared-db.yml`이 아니라 `.env`의 기존
`DB_USERNAME`/`DB_PASSWORD`/`DB_NAME`에 넣는다.

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

## 스코프 밖

- NAS가 아닌 스토리지에서의 active/standby 구성 — ADR-0003에 방향만
  기록, 아직 구현 안 됨.
- Postgres 자체의 HA/백업 — 전용 호스트 운영자 책임.
- 실 NAS/전용 DB 호스트에서의 스모크 테스트 — 이 저장소의 로컬 환경과
  CI에서는 재현 불가능하다(진짜 별도 호스트·NAS 마운트 필요). 위
  명령을 처음 실 배포에 적용하기 전에 반드시 실제 환경에서 최소 1회
  수동 검증한다.
