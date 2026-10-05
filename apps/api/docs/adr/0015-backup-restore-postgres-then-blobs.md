# 백업/복구는 GC와 동일한 외부 트리거 프로세스로 만들고, Postgres 스냅샷 → Blob 순서를 불변식으로 둔다

`OPS-02`는 Postgres metadata와 Blob 스토리지 object를 함께 백업·복구한다.
로드맵은 이 조합에 참고할 기존 사례가 없다고 명시했다.

- `backup:run`/`restore:run`은 단발성 프로세스로 실행한다.
- `gc-main.ts`와 같이 `NestFactory.createApplicationContext`로 부트스트랩한다.
- Compose profile은 각각 `backup`과 `restore`로 분리한다.
- 상시 실행하는 `app`과 분리한다.
- 운영자가 외부 cron 등으로 실행한다.

GC와 같은 외부 트리거 운영 모델을 사용한다.

## 정합성 순서: Postgres 먼저, Blob 나중

업로드는 object를 먼저 저장하고 성공 후 Postgres의 blob row를 커밋한다.
Postgres 스냅샷이 참조하는 Blob은 스냅샷 시점에 이미 스토리지에 존재한다.

백업 순서:

1. Postgres 스냅샷을 만든다.
2. Blob을 미러링한다.

반대 순서를 쓰면 두 스냅샷 사이에 생성된 참조의 object가 Blob 백업에서 빠질 수 있다.
복구 시 dangling reference가 생기는 원인이다.
GC도 object를 먼저 삭제하고 metadata를 나중에 삭제한다(api ADR-0006).

Blob의 불변성만으로 동시 GC 삭제를 막을 수는 없다.
백업 중 쓰기·GC 중단 절차는 `docs/deployment/backup-restore.md` “백업”을 따른다.
`backup:run`은 쓰기나 GC를 자동으로 중단하지 않는다.

## 복구 순서: Postgres, Blob 복원, 백업에 없는 Blob 삭제

`restore:run`은 다음 순서로 실행한다.

1. Postgres를 복구한다.
2. 백업의 `blobs/`를 스토리지에 put한다.
3. `STORIX_RESTORE_FORCE=true`이면 백업에 없는 object를 삭제한다.

Postgres 복구가 `pg_restore` 실패 등으로 중단되면 스토리지 object는 변경하지 않는다.
복구 전에 object를 먼저 지우면 이 실패가 빈 버킷으로 남는다.
같은 `STORIX_RESTORE_SOURCE_DIR`로 재실행하면 `--clean`과 put 덮어쓰기로 이어서 복구된다.

3단계는 put이 모두 끝난 뒤에 실행한다.
put 도중 실패해도 기존 object가 남는다.
3단계가 실패하면 복구도 실패로 끝낸다. Postgres와 백업 object는 이미 복원된 상태이고, 재실행하면 같은 결과가 된다.

## 백업 방식

- **Postgres**
  - `pg_dump` 논리 백업을 사용한다.
  - PITR(`pg_basebackup` + WAL 아카이빙)은 도입하지 않는다.
  - 단일 고객 인스턴스에서는 WAL 목적지 관리 비용이 요구에 비해 크다고 판단했다.
- **Blob 스토리지**
  - 기존 `BlobStorage`(S3 SDK 래퍼)로 Storix가 만드는 key의 prefix(`blobs/`, `upload-staging/`)만 순회한다.
  - 같은 버킷의 다른 object는 백업·복구·force 삭제 대상이 아니다. GC의 스캔 범위와 같다.
  - object를 로컬 백업의 `blobs/`에 복사한다.
  - 별도 미러링 바이너리는 추가하지 않는다.
  - 기존 스토리지 통합 테스트 하네스를 사용한다.
- **목적지**
  - 로컬 파일시스템만 지원한다.
  - 완료된 백업은 `{STORIX_BACKUP_DIR}/{ISO8601 타임스탬프}/`에 둔다.
  - 기존 설정 표기는 `BACKUP_DIR`다.
  - 타임스탬프의 콜론과 점은 디렉터리 이름에서 대시로 치환한다.
  - 오프호스트 반출과 retention은 운영자 책임이다.
  - 운영자는 rsync, restic, logrotate류 도구로 백업을 관리한다.
- **복구 범위**
  - 인스턴스 전체 재해복구만 지원한다.
  - namespace 단위 부분 복구는 지원하지 않는다.
  - 수요가 생기면 별도 ADR로 재검토한다.

## 마스터 키는 백업 대상이 아니다

- `STORIX_ENCRYPTION_MASTER_KEY`(기존 표기 `ENCRYPTION_MASTER_KEY`)는 배포 환경변수다(api ADR-0009).
- 키는 Postgres와 스토리지에 저장하지 않는다.
- 키를 분실하면 백업으로도 `ENCRYPTED` namespace 데이터를 복호화할 수 없다.
- `backup:run`은 실행마다 `ENCRYPTED` namespace 존재 여부를 확인한다.
- 존재하면 마스터 키의 별도 채널 백업을 확인하라는 콘솔 경고를 남긴다.
- 운영자의 실제 키 백업 여부는 코드로 검증할 수 없다.

경고는 자동화된 cron 실행 로그에도 남긴다.

## restore는 기본적으로 파괴적 작업을 거부한다

- namespace 데이터가 있으면 `restore:run`은 기본적으로 중단한다.
- 덮어쓰려면 `STORIX_RESTORE_FORCE=true`를 명시한다.
- 기존 설정 표기는 `RESTORE_FORCE=true`다.

대상 판정:

- `BackupRepository.hasExistingNamespaces()`로 Postgres namespace row 존재 여부를 확인한다.
- 스토리지 버킷 내용은 판정에 사용하지 않는다.
- namespace가 없으면 잔여 object가 있어도 force 없이 복구한다.

namespace는 사용자 데이터의 최상위 소유자다.
이 판정은 라이브 인스턴스를 실수로 덮어쓰는 사고를 줄이기 위한 결정이다.

```txt
위험도: 높음
롤백: 복구 전 대상의 별도 백업이 있어야 가능. 덮어쓴 데이터는 복구에 사용한 백업만으로 되돌릴 수 없다.
```

## 검증

- round-trip 통합 테스트를 작업 범위에 포함한다.
- 절차는 백업 → 새 인스턴스 복구 → 데이터 일치 확인이다.
- 기존 Postgres·S3 호환 스토리지 testcontainers 관례를 사용한다.

재해 시에 사용하는 코드의 결함을 평소 자동 검증으로 발견하기 위한 결정이다.

## Considered Options

- **버킷 버저닝**
  - object 이력을 보존할 수 있다.
  - GC의 grace-period 삭제 의미론과 상호작용을 설계해야 한다(api ADR-0006).
  - 이 추가 설계가 필요해 보류했다.
- **`pg_basebackup` + WAL PITR**
  - 임의 시점 복구가 가능하다.
  - WAL 아카이브 목적지 관리 비용이 현재 요구보다 커 보류했다.
- **Storix가 원격 백업 목적지(S3 등)를 직접 관리**
  - 자격증명과 설정 항목이 늘어난다.
  - self-host 배포의 오프호스트 반출은 운영자에게 맡긴다.
- **Blob 먼저, Postgres 나중**
  - 두 스냅샷 사이에 생성된 참조의 object가 백업에서 빠질 수 있다.
  - dangling reference 위험이 있어 채택하지 않았다.
