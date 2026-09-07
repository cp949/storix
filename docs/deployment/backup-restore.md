# 백업/복구 운영 절차

OPS-02. Postgres(metadata) + MinIO(object) 양쪽 상태를 갖는 배포의 재해복구
절차다. 설계 배경은
`../../apps/api/docs/adr/0015-backup-restore-postgres-then-minio.md` 참고.

## 백업

```bash
docker compose --profile backup run --rm backup
```

`BACKUP_DIR`(기본 `/backups`, 호스트의 `./backups`에 바인드 마운트) 아래
`{ISO8601 타임스탬프}/` 디렉터리에 `postgres.dump`(pg_dump custom format)와
`minio/`(MinIO 버킷 전체 미러)를 남긴다. 실행마다 ENCRYPTED namespace가
있으면 콘솔에 경고가 남는다 — `ENCRYPTION_MASTER_KEY`는 이 백업에 포함되지
않으므로 별도 채널(시크릿 매니저 등)에 반드시 따로 백업해야 한다.

오프호스트 반출과 보존(retention) 정책은 운영자 책임이다. 예:

```bash
rsync -a ./backups/ user@offsite:/backups/storix/
```

## 복구

새 인스턴스(또는 데이터를 버릴 각오가 된 기존 인스턴스)에서:

```bash
RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose --profile restore run --rm restore
```

대상에 이미 namespace 데이터가 있으면 기본적으로 거부한다(`RestoreTargetNotEmptyError`).
의도적으로 덮어쓰려면:

```bash
RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z RESTORE_FORCE=true \
  docker compose --profile restore run --rm restore
```

```txt
위험도: 높음
롤백: 불가능 — 대상의 기존 Postgres 데이터와 MinIO 오브젝트가 전부 지워지고
백업 시점 상태로 교체된다.
```

## 범위 밖

- namespace 단위 부분 복구는 지원하지 않는다 — 인스턴스 전체 재해복구만
  지원한다.
- point-in-time recovery(PITR)는 지원하지 않는다 — 백업 실행 시점 스냅샷만
  남는다.
- `ENCRYPTION_MASTER_KEY` 백업은 이 절차에 포함되지 않는다 — 분실하면
  `ENCRYPTED` namespace 데이터는 이 절차로 복구되지 않는다(ADR-0009).
