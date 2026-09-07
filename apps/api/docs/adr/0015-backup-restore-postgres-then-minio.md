# 백업/복구는 GC와 동일한 외부 트리거 프로세스로 만들고, Postgres 스냅샷 → MinIO 순서를 불변식으로 둔다

OPS-02(백업/복구)는 Postgres(metadata)와 MinIO(object) 양쪽에 상태가 나뉘어 있어 참고할
기존 사례가 없다(로드맵에 명시). `backup:run`/`restore:run`을 `gc-main.ts`와 동일하게
`NestFactory.createApplicationContext`로 띄우는 단발성 프로세스로 추가하고,
`docker-compose.yml`에 `profiles: ['backup']`로 묶어 상시 기동되는 `app`과 분리한다.
운영자(외부 cron 등)가 트리거하는 구조로, GC job이 이미 확립한 운영 모델을 그대로
따른다.

## 정합성 순서: Postgres 먼저, MinIO 나중

`content.service.ts`의 업로드 경로는 MinIO object를 먼저 쓰고, 성공해야 Postgres에
blob row를 커밋한다(object-먼저-metadata-나중). 따라서 Postgres 스냅샷 시점에
참조되는 모든 blob은 그 스냅샷 시점 이전에 이미 MinIO에 존재함이 보장된다. `backup:run`은
이 순서(Postgres 스냅샷 → MinIO 미러)를 불변식으로 강제한다. 반대 순서(MinIO 먼저)를
쓰면 두 스냅샷 사이에 새로 업로드·참조된 blob이 Postgres 스냅샷엔 잡히고 MinIO
스냅샷엔 없어, 복구 시 참조가 깨진(dangling) 상태가 된다. 이 불변식은 GC가 삭제에
쓰는 "object 먼저, metadata 나중" 순서(ADR-0006)와 대칭이다.

## 백업 방식

- **Postgres**: `pg_dump` 논리 백업만 쓴다. PITR(`pg_basebackup`+WAL 아카이빙)은 단일
  고객 인스턴스 규모에서 과설계이고, WAL 목적지 관리라는 별도 운영 부담을 지운다.
- **MinIO**: 별도로 `mc` 바이너리를 이미지에 추가하지 않고, 이미 앱 전역에서
  쓰는 `BlobStorage`(MinIO JS SDK 래퍼) 인터페이스로 버킷 전체를 순회하며
  로컬 경로에 복사한다. `mc mirror`와 목표(무중단 전체 복사)는 같지만, 새
  바이너리 의존성이 늘지 않고 기존 통합 테스트 하네스로 그대로 검증된다.
  Blob이 불변이라는 성질은 동일하게 적용된다 — 실행 중인 MinIO에 대해서도
  무중단·안전하게 복사할 수 있다.
- **목적지**: 로컬 파일시스템만 지원한다. 오프호스트 반출과 보존(retention) 정책은
  운영자 책임으로 남기고, Storix는 백업마다 `{BACKUP_DIR}/{ISO8601}/` 형태의 타임스탬프
  디렉터리만 만들어 운영자가 자신의 툴(rsync, restic, logrotate류 등)로 다루기 쉽게
  한다.
- **복구 범위**: 인스턴스 전체 재해복구만 지원한다. namespace 단위 부분 복구는 범위
  밖이다 — 수요가 생기면 별도 ADR로 재검토한다.

## 마스터 키는 백업 대상이 아니다

`ENCRYPTION_MASTER_KEY`는 Postgres에도 MinIO에도 없고 배포 환경변수로만 존재한다
(ADR-0009). 이 키를 분실하면 `ENCRYPTED` namespace 데이터는 이 백업/복구 절차로
복구되지 않는다. `backup:run`은 실행마다 `ENCRYPTED` namespace 존재 여부를 조회해,
있으면 "마스터 키를 별도 채널에 백업했는지 확인하라"는 경고를 stdout에 남긴다 — 코드
검증은 불가능하지만(운영자가 실제로 키를 백업했는지는 알 수 없음), 자동화된 cron
실행 로그에도 남는 마지막 리마인더 역할을 한다.

## restore는 기본적으로 파괴적 작업을 거부한다

`restore:run`은 대상 Postgres/MinIO가 비어있지 않으면 기본적으로 에러로 중단하고,
`--force`를 명시해야 덮어쓰기를 진행한다. 오작동으로 라이브 인스턴스에 restore를
돌려 데이터를 덮어쓰는 사고가, 복구 편의성보다 훨씬 비싸다.

## 검증

round-trip(백업 → 새 인스턴스에 restore → 데이터 일치 확인) 통합 테스트를 이번
티켓 범위에 포함한다. 기존 Postgres/MinIO testcontainers 통합 테스트 관례를 그대로
쓴다. 평소엔 실행되지 않다가 재해 시에만 쓰이는 코드는 자동 검증이 없으면 정작
필요한 순간 깨져 있을 위험이 가장 크다.

## Considered Options

- **MinIO 버킷 버저닝 활성화**: 별도 인프라 변경 없이 자체 히스토리를 보존할 수
  있지만, GC의 grace-period 기반 삭제 의미론(ADR-0006)과 새로 상호작용을 설계해야
  해서 보류했다.
- **`pg_basebackup`+WAL PITR**: 임의 시점 복구가 가능하지만 WAL 아카이브 목적지
  관리라는 운영 복잡도가 이 단계의 요구보다 크다.
- **Storix가 원격 백업 목적지(S3 등)를 직접 설정**: 별도 자격증명 관리·설정 표면이
  늘어난다. self-host 배포 관례대로 오프호스트 반출은 운영자 몫으로 남겼다.
- **MinIO 먼저, Postgres 나중 순서**: 두 스냅샷 사이에 생긴 새 참조가 MinIO 백업에
  없을 수 있어 dangling reference 위험이 생긴다. 채택하지 않았다.
