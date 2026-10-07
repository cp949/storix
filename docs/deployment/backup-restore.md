# 백업/복구 운영 절차

OPS-02. Postgres metadata와 S3 호환 스토리지 object를 함께 복구하는 절차다.
결정은 [api ADR-0015](../../apps/api/docs/adr/0015-backup-restore-postgres-then-blobs.md)를 따른다.

Compose 명령은 실제 배포의 `-f` 조합을 사용한다.
예를 들어 `-f docker-compose.yml -f docker-compose.versitygw.yml`을 붙인다.
조합이 다르면 `backup`·`restore`가 다른 DB·스토리지를 사용한다.

온라인 PUT와 multipart 회수의 배포 전환은 [api ADR-0045](../../apps/api/docs/adr/0045-gc-incomplete-multipart-upload.md)를 따른다.

## PUT 소유권 schema 전환

PUT 소유권 schema를 처음 적용할 때 다음 순서를 따른다.

1. 모든 API writer와 GC를 중단한다.
2. API 프로세스뿐 아니라 VersityGW 등 storage worker의 진행 중 요청도 끝났는지 외부에서 확인한다.
3. API migration을 실행한다.

   ```bash
   docker compose run --rm migrate
   ```

4. API와 GC를 시작한다.
5. API·GC 시작 로그의 storage PUT 실행 식별자를 운영 기록에 남긴다.

이전 버전이 만든 multipart에는 소유권 행이 없다.
새 GC는 해당 upload의 자동 abort를 보류한다.
기존 multipart는 모든 writer와 GC를 중단한 유지보수 시간에 `storage-put:list-legacy`로 목록을 만들고 운영자가 확인한 manifest만 `storage-put:abort-legacy`로 회수한다.
CLI 명령은 api ADR-0045와 `apps/api` 패키지의 `storage-put:admin` 스크립트를 따른다.

유지보수 예:

```bash
pnpm --filter @cp949/storix-api storage-put:admin -- list-legacy > /tmp/storix-legacy-multipart.json
cat /tmp/storix-legacy-multipart.json
pnpm --filter @cp949/storix-api storage-put:admin -- abort-legacy \
  --manifest /tmp/storix-legacy-multipart.json \
  --sha256 "$(jq -r .sha256 /tmp/storix-legacy-multipart.json)" \
  --all-writers-and-gc-stopped
```

운영자는 manifest의 각 `key`, `uploadId`, `initiated`와 `sha256`를 검토한다.
abort 명령은 SHA-256이 일치하고 현재도 owner 미등록인 목록만 처리한다.
writer와 GC는 abort 명령이 끝날 때까지 중단 상태를 유지한다.

프로세스 종료 확인은 로그의 실제 실행 식별자를 사용한다.

```bash
pnpm --filter @cp949/storix-api storage-put:admin -- confirm-stopped <execution-id> \
  --writer-and-storage-worker-stopped
```

명령 실행자는 해당 API·GC 실행과 그 storage worker가 끝났음을 외부에서 확인해야 한다.
CLI는 프로세스 종료 상태를 자동 감지하지 않는다.

schema migration을 되돌리면 PUT 소유권 기록도 제거된다.
활성 writer가 있을 때 migration을 되돌리지 않는다.
롤백 뒤에는 기존 upload가 owner unknown으로 처리되어 자동 회수가 보류된다.

```txt
위험도: 높음
롤백: migration down으로 테이블을 제거할 수 있다. 소유권 기록은 복원되지 않으므로 모든 writer·GC를 중단한 상태에서만 수행한다.
```

`docker-compose.override.yml` 또는 `COMPOSE_FILE`로 조합을 고정하면 아래 명령을 그대로 쓸 수 있다.
설정 방법은 [README](../../README.md)의 "실행"을 따른다.

## 백업

백업 순서:

1. 모든 API 인스턴스의 쓰기와 `gc` 실행을 중단한다.
2. `backup`을 실행한다.

   ```bash
   docker compose --profile backup run --rm backup
   ```

3. 백업 완료를 확인한다.
4. 쓰기와 GC를 재개한다.

`backup` job은 쓰기를 자동으로 중단하지 않는다.
Postgres dump 뒤에 스토리지 미러를 실행한다.
두 단계 사이에 GC가 object를 삭제하면 dump의 참조 대상이 백업에서 빠질 수 있다.
복구 후 GC는 누락된 바이트를 복원할 수 없다.

백업 파일:

- 경로는 `STORIX_BACKUP_DIR/{ISO8601 타임스탬프}/`다.
- `STORIX_BACKUP_DIR`의 기본값은 `/backups`다.
- Compose는 호스트의 `./backups`를 `/backups`에 마운트한다.
- `postgres.dump`는 `pg_dump` custom format이다.
- `blobs/`는 스토리지 버킷 중 Storix prefix(`blobs/`, `upload-staging/`) 아래 object의 미러다. 로컬 경로는 `blobs/blobs/…`, `blobs/upload-staging/…`다.
- 같은 버킷의 다른 시스템 object는 백업하지 않는다.
- Storix prefix 안에서 경로 정규화로 key가 달라지는 object(`a//b`, 끝 슬래시)가 있으면 백업이 해당 key를 오류에 담고 실패한다. 이 object는 Storix가 만들지 않는다.

완료 판정:

- 작업 중에는 `{타임스탬프}.partial/`에 쓴다.
- 모든 단계가 성공하면 최종 디렉터리 이름으로 rename한다.
- `.partial` 디렉터리는 진행 중이거나 실패한 백업이다.
- 보존·회전 스크립트는 `.partial`이 없는 디렉터리만 완료된 백업으로 취급한다.

암호화 키:

- ENCRYPTED namespace가 있으면 콘솔에 경고를 남긴다.
- `STORIX_ENCRYPTION_MASTER_KEY`는 백업에 포함하지 않는다.
- 시크릿 매니저 등 별도 채널에 키를 백업한다.

오프호스트 반출과 보존(retention) 정책은 운영자 책임이다.
반출 예:

```bash
rsync -a ./backups/ user@offsite:/backups/storix/
```

## 복구

1. 모든 API 인스턴스와 GC를 정지한다.
   - storage PUT worker가 끝났는지 외부에서 확인한다. API 프로세스 종료만으로 gateway worker 종료를 판정하지 않는다.
   - Postgres 복구는 대상의 Storix 테이블을 모두 삭제하고 백업 시점 스키마로 다시 만든다.
   - single-instance Compose의 API 정지 명령은 다음과 같다.

   ```bash
   docker compose stop app
   ```

2. 복구할 백업을 지정한다.
   - 빈 인스턴스에 복구한다.
   - 기존 인스턴스를 덮어쓰면 대상 데이터가 백업 상태로 교체된다.

   ```bash
   STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z docker compose --profile restore run --rm restore
   ```

   - namespace 데이터가 있으면 `RestoreTargetNotEmptyError`로 거부한다.
   - 의도적인 덮어쓰기는 `STORIX_RESTORE_FORCE=true`를 지정한다.

   ```bash
   STORIX_RESTORE_SOURCE_DIR=/backups/2026-09-08T12-00-00-000Z STORIX_RESTORE_FORCE=true \
     docker compose --profile restore run --rm restore
   ```

   ```txt
   위험도: 높음
   롤백: 불가능. 대상의 기존 Postgres 데이터와 Storix prefix 아래 스토리지 object를 백업 시점 상태로 교체한다.
   ```

   - 실행 순서는 Postgres 복구, 백업 object put, (force일 때) 백업에 없는 object 삭제다.
   - force 삭제는 Storix prefix(`blobs/`, `upload-staging/`) 안의 object만 대상으로 한다. 같은 버킷의 다른 시스템 object는 지우지 않는다.
   - 이전 버전이 만든 백업은 버킷 전체를 미러링했을 수 있다. 복구는 Storix prefix 밖 key를 되살리지 않고 건수와 예시 key를 경고로 남긴다.
   - Postgres 복구는 `public` 스키마에서 접속 사용자(`STORIX_DB_USERNAME`)가 소유한 테이블을 모두 지운 뒤 dump를 적재한다.
     - Storix 전용 DB를 전제로 한다. 같은 사용자가 소유한 다른 테이블도 지워진다.
     - 백업을 만든 DB 사용자와 다른 사용자로도 복구할 수 있다. 소유자와 권한은 복구하지 않는다.
   - Postgres 복구가 실패하면 스토리지 object는 변경하지 않는다.
     - dump 적재는 한 트랜잭션이다. 실패하면 적재분 없이 테이블이 없는 상태로 남는다.
     - 원인을 고친 뒤 같은 `STORIX_RESTORE_SOURCE_DIR`로 재실행한다. 테이블이 없으면 비어 있는 대상으로 보므로 force 없이 재실행할 수 있다.
   - 이름이 `.partial`로 끝나는 디렉터리는 `RestoreIncompleteBackupError`다.
   - `.partial` 검사는 DB 복구와 스토리지 접근 전에 수행한다.
   - `.partial`을 수동으로 rename한 백업은 완료 여부를 판별하지 못한다. 이름을 바꾸기 전에 백업 로그의 `백업 완료` 줄을 확인한다.
   - `blobs/` 외의 하위 디렉터리는 `RestoreUnsupportedBackupError`다.
   - `blobs/` 구조 검사는 기존 데이터를 지우기 전에 수행한다.
   - 지원하지 않는 이전 백업 형식은 복구할 수 없다.

3. 복구가 성공하면 필요한 migration을 실행한다.
   - 백업 시점과 현재 이미지 버전이 다르면 `migrate`를 다시 실행한다.
   - Postgres 복구는 `migrations` 테이블도 백업 시점으로 되돌린다. 백업 이후 버전의 테이블은 남지 않으므로 `migrate`가 다시 적용한다.

   ```bash
   docker compose run --rm migrate
   ```

4. migration 성공을 확인한 뒤 `app`을 시작한다.
   - GC도 복구·migration 완료 뒤에 재개한다.
   - 복원된 process 실행을 자동으로 종료 확인하지 않는다. owner 상태가 불명확한 multipart는 유지보수 목록으로 별도 확인한다.

   ```bash
   docker compose start app
   ```

## 로컬 통합 테스트

- 통합 테스트는 Postgres 16 서버를 사용한다.
- 호스트의 `pg_dump`·`pg_restore` client major도 16으로 맞춘다.
- 더 낮은 client는 backup에서 버전 불일치로 실패한다.
- Postgres 17 client의 restore 실패 기록은 [Postgres 버전 검증 이력](./postgres-versions.md)을 따른다.

운영 이미지:

- client major는 `apps/api/Dockerfile` runtime stage의 `PG_CLIENT_MAJOR`로 정한다.
- 기본값은 17이다.
- client major는 서버 major와 맞춘다.
- Postgres 16 서버는 `-pg16` 이미지 또는 아래 소스 빌드를 사용한다.

```bash
docker build --build-arg PG_CLIENT_MAJOR=16 -f apps/api/Dockerfile -t storix-api:pg16 .
```

Compose 소스 빌드는 `docker-compose.override.yml`의 `build.args`에 같은 값을 지정한다.
client·서버 조합별 결과는 [Postgres 버전 검증 이력](./postgres-versions.md)을 따른다.

## 범위 밖

- namespace 단위 부분 복구는 지원하지 않는다. 인스턴스 전체 재해복구만 지원한다.
- point-in-time recovery(PITR)는 지원하지 않는다. 백업 실행 시점의 스냅샷만 보존한다.
- `STORIX_ENCRYPTION_MASTER_KEY`는 별도로 백업한다. 키를 잃으면 ENCRYPTED 데이터는 복구할 수 없다(ADR-0009).
- 복구된 object의 Content-Type은 `application/octet-stream`이다.
- presigned download에 원래 Content-Type이 필요하면 해당 파일을 재업로드한다.
