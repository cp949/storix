# Namespace 논리 저장량 상한

## 계약

논리 사용량은 namespace의 현재 live FILE byte 수와 유지 중인 모든 snapshot의 FILE entry 크기 합이다. 같은 Blob을 여러 경로 또는 snapshot이 참조하면 각 논리 항목을 따로 센다. 디렉터리는 0 bytes다. FILE snapshot은 해당 live 파일 크기를 한 번 더 보유한 것으로 계산하고, TREE snapshot은 manifest의 각 FILE entry를 계산한다.

전역 `STORIX_MAX_TOTAL_LOGICAL_BYTES`는 양수 64-bit decimal byte 값이며 기본값은 `53687091200`(50 GiB)다. namespace는 이보다 작거나 같은 `maxTotalLogicalBytes` override를 둘 수 있고, 없으면 전역값을 상속한다. namespace 조회/생성 응답의 `quota.limitBytes`와 `quota.usedBytes`는 decimal string이다.

전역 상한은 프로세스 시작 시 `ConfigService`에서 한 번 해석한다. mutation 강제(`VfsNodeRepository`), namespace 응답과 override 검증(`NamespaceService`·`NamespaceQuotaService`)은 모두 이 값을 쓰며 `process.env`를 요청 시점에 직접 읽지 않는다. 값을 바꾸면 API 프로세스를 재시작해야 한다.

## 원자성 및 오류

모든 VFS mutation은 namespace root lock/transaction 안에서 기존 live 파일 합계와 변경 delta를 계산한다. snapshot 생성·삭제도 같은 transaction에 quota delta와 저장 수를 반영한다. 최종 사용량이 상한을 넘고 요청이 양의 delta를 만들면 mutation 전체를 rollback하고 413 `VFS_QUOTA_EXCEEDED`를 반환한다. 0 또는 음수 delta는 이미 상한 초과인 namespace에서도 허용된다. restore는 유지 중 snapshot bytes에 복원 후 live bytes를 더해 판단한다.

조건부 mutation과 snapshot mutation의 deterministic quota 413은 기존 receipt 계약에 따라 저장·재생된다. quota 변경 후에도 완료 receipt는 그대로 재생되므로 다른 조건으로 시도할 때 새 `Idempotency-Key`를 사용한다. 관리 변경 API는 `STORIX_ADMIN_API_KEY` 전용 guard와 필수 idempotency key를 사용한다. 요청 키는 namespace 범위로 파생 저장되며 canonical request hash가 다르면 충돌한다. 변경은 같은 root lock transaction에서 quota 설정과 receipt를 함께 기록한다.

## 영속화와 운영

`live_file_byte_count`는 migration이 기존 FILE node의 `size` 합으로 backfill하며 이후 파일 생성·수정·삭제·복사·복원 delta로 유지한다. retained snapshot byte counter는 기존 저장소 계수를 재사용한다. 신규 schema migration은 기존 API에서 동기화 없이 실행할 수 있는 nullable override 및 default-zero counter 추가로 구성된다.

`.env.example` 및 compose는 전역 상한과 별도 현재/이전 관리자 키를 API에 전달한다. 키가 설정되지 않으면 관리자 route는 fail closed다. 일반 API key로 관리자 route를 호출할 수 없다.

통합 검증은 SQLite와 PostgreSQL 두 드라이버의 migration backfill, root-lock 동시 변경, snapshot 유지량, quota 거부/rollback과 HTTP response를 확인한다. 실행된 자동 검증은 실제 배포 DB migration, 운영 설정, 백업 복원, 외부 consumer 연동을 증명하지 않는다.
