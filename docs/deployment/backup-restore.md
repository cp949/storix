# 백업/복구 운영 절차

OPS-02. Postgres(metadata) + MinIO(object) 양쪽 상태를 갖는 배포의 재해복구
절차다. 설계 배경은
`../../apps/api/docs/adr/0015-backup-restore-postgres-then-minio.md` 참고.

아래 `docker compose ...` 명령은 실제 배포에 쓰는 `-f` 조합(예:
`-f docker-compose.yml -f docker-compose.versitygw.yml`)을 그대로 앞에 붙여
실행한다 — 조합이 다르면 `backup`/`restore`가 다른 DB·스토리지를 본다.
`docker-compose.override.yml`이나 `COMPOSE_FILE`로 조합을 고정해 두면
(`README.md` 실행 절 참고) 아래 명령을 그대로 쓸 수 있다.

## 백업

```bash
docker compose --profile backup run --rm backup
```

`STORIX_BACKUP_DIR`(기본 `/backups`, 호스트의 `./backups`에 바인드 마운트) 아래
`{ISO8601 타임스탬프}/` 디렉터리에 `postgres.dump`(pg_dump custom format)와
`minio/`(MinIO 버킷 전체 미러)를 남긴다. 실행마다 ENCRYPTED namespace가
있으면 콘솔에 경고가 남는다 — `STORIX_ENCRYPTION_MASTER_KEY`는 이 백업에 포함되지
않으므로 별도 채널(시크릿 매니저 등)에 반드시 따로 백업해야 한다.

백업은 `{타임스탬프}.partial/`에 쓰인 뒤 전부 성공한 경우에만 최종 이름으로
rename된다. 따라서 `.partial` 접미사가 붙은 디렉터리는 실패했거나 진행 중인
백업이며, 보존/회전 스크립트는 이 접미사가 없는 디렉터리만 완결된 백업으로
취급하면 된다.

`backup`은 `gc`와 동시에 돌리지 않는다. 백업은 Postgres 스냅샷 시점의 MinIO
버킷을 미러하는데, 두 단계 사이에 GC가 orphan object를 지우면 그만큼 미러에서
빠진다(복구된 인스턴스는 다음 GC 실행에서 스스로 정합해지므로 데이터 손상은
아니다). 불필요한 경합을 만들지 않도록 cron 스케줄을 겹치지 않게 둔다.

오프호스트 반출과 보존(retention) 정책은 운영자 책임이다. 예:

```bash
rsync -a ./backups/ user@offsite:/backups/storix/
```

## 복구

복구 전에 `app`을 정지한다 — `pg_restore --clean`이 테이블을 drop하고 다시
만드는 동안 `app`이 그 테이블에 라이브 트래픽을 태우고 있으면 안 된다.

```bash
docker compose stop app
```

새 인스턴스(또는 데이터를 버릴 각오가 된 기존 인스턴스)에서:

```bash
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose --profile restore run --rm restore
```

대상에 이미 namespace 데이터가 있으면 기본적으로 거부한다(`RestoreTargetNotEmptyError`).
의도적으로 덮어쓰려면:

```bash
STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z STORIX_RESTORE_FORCE=true \
  docker compose --profile restore run --rm restore
```

```txt
위험도: 높음
롤백: 불가능 — 대상의 기존 Postgres 데이터와 MinIO 오브젝트가 전부 지워지고
백업 시점 상태로 교체된다.
```

복구가 끝나면 `app`을 다시 올린다.

```bash
docker compose start app
```

백업을 뜬 Storix 버전이 현재 배포된 이미지 버전과 다르면 복구 후 `migrate`를
다시 실행해야 한다 — `pg_restore --clean`이 `migrations` 테이블까지 백업 시점의
이력으로 덮어쓰기 때문이다.

```bash
docker compose run --rm migrate
```

## 로컬 통합 테스트

이 기능의 통합 테스트는 호스트에 Postgres major 16 이상의
`pg_dump`/`pg_restore` 클라이언트를 요구한다. Debian/Ubuntu 기본 apt 저장소는
그보다 낮은 버전을 주는 경우가 많고, 낮은 client는 16 서버에 대해 버전 불일치로
하드 실패한다(운영 이미지가 PGDG 저장소를 쓰는 이유와 같다 —
`apps/api/Dockerfile`의 설치 단계 참고).

## 범위 밖

- namespace 단위 부분 복구는 지원하지 않는다 — 인스턴스 전체 재해복구만
  지원한다.
- point-in-time recovery(PITR)는 지원하지 않는다 — 백업 실행 시점 스냅샷만
  남는다.
- `STORIX_ENCRYPTION_MASTER_KEY` 백업은 이 절차에 포함되지 않는다 — 분실하면
  `ENCRYPTED` namespace 데이터는 이 절차로 복구되지 않는다(ADR-0009).
- 복구된 오브젝트의 Content-Type은 보존되지 않는다 — 전부
  `application/octet-stream`으로 복원되므로, presigned download가 필요한 파일은
  복구 후 재업로드해야 원래 Content-Type이 돌아온다.
