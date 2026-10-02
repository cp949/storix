# Postgres 버전 검증 이력

Storix는 지원하는 Postgres major 범위를 선언하지 않는다.
이 문서는 실제로 실행해 확인한 결과만 기록한다.
기록에 없는 조합은 검증하지 않은 것이다.

기본 검증 대상은 Postgres 16이다. 개발·테스트 이미지와 운영 이미지의 `pg_dump` client가 모두 16이다.

## 검증 결과

| 일자       | 서버       | `pg_dump` client | 실행한 것                                                     | 결과            |
| ---------- | ---------- | ---------------- | ------------------------------------------------------------- | --------------- |
| 2026-10-02 | 17.11      | —                | 계약 검증 `pnpm contract --db postgres`(70개, migration 포함) | 통과 70, 실패 0 |
| 2026-10-02 | 17.11      | 16.15            | backup·restore integration spec 3개(17개 테스트)              | 통과 2, 실패 15 |
| 2026-10-02 | 17.11      | 17.11            | 위와 같음                                                     | 통과 17, 실패 0 |
| 2026-10-02 | 16(alpine) | 17.11            | 위와 같음                                                     | 통과 17, 실패 0 |

- 실패 원인: `pg_dump: error: aborting because of server version mismatch`. client 버전이 서버 major보다 낮으면 `pg_dump`가 중단한다.
- 17 client는 임시 래퍼(`docker run postgres:17-alpine pg_dump`)로 실행했다. 이미지는 바꾸지 않았다.
- backup·restore spec 3개: `backup.repository`, `restore.job`, `backup-restore-namespace-id`.
- 각 실행에서 dump와 restore는 같은 서버 major에서 수행했다. 16에서 만든 dump를 17에 복구하는 경로는 검증하지 않았다.
- 계약 70개 외에 `apps/api`의 전체 integration spec, 부하·규모 측정은 17에서 실행하지 않았다.

## 사용 시 주의

- 서버가 16이 아니면 `backup`·`restore` job은 이미지의 `pg_dump` client 버전과 서버 major가 같거나 client가 더 높아야 한다.
- 현재 이미지(`apps/api/Dockerfile`)는 `postgresql16-client`만 설치한다. 17 서버에서는 `backup`·`restore`가 실패한다.
- 따라서 외부 Postgres가 16이 아니면 `backup`·`restore` job을 이 이미지로 실행할 수 없다.

## CI

`계약 검증` 워크플로(`.github/workflows/contract.yml`)의 Postgres job이 16과 17을 matrix로 실행한다.
이 job은 수동 실행과 주 1회 스케줄에서만 돈다.
`pg_dump` 경로(backup·restore)는 matrix에 포함하지 않는다.

로컬에서 다른 major로 계약을 실행하려면 이미지를 환경변수로 지정한다.

```bash
STORIX_CONTRACT_PG_IMAGE=postgres:17-alpine pnpm contract --db postgres
```
