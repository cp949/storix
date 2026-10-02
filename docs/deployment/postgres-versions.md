# Postgres 버전 검증 이력

Storix는 지원하는 Postgres major 범위를 선언하지 않는다.
이 문서는 실제로 실행해 확인한 결과만 기록한다.
기록에 없는 조합은 검증하지 않은 것이다.

기본 검증 대상은 Postgres 16이다. 개발·테스트 이미지와 운영 이미지의 `pg_dump` client가 모두 16이다.

## 검증 결과

2026-10-02에 실행했다.

| 서버  | 실행한 것                                                             | 결과                                                                |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 17.11 | 계약 검증 `pnpm contract --db postgres`(70개, migration 포함)         | 통과 70, 실패 0                                                     |
| 17.11 | 이미지의 16 client로 backup·restore spec 3개(17개 테스트)             | 통과 2, 실패 15 (`pg_dump` 버전 불일치)                             |
| 17.11 | 17 client로 compose 스택 backup → 빈 대상 restore → 파일 SHA-256 비교 | 통과                                                                |
| 16.15 | 17 client로 compose 스택 backup                                       | 통과                                                                |
| 16.15 | 17 client로 compose 스택 restore                                      | 실패 (`unrecognized configuration parameter "transaction_timeout"`) |

- 실패 원인(17 서버 + 16 client): `pg_dump: error: aborting because of server version mismatch`.
- 실패 원인(16 서버 + 17 client): 17 `pg_restore`가 `SET transaction_timeout = 0;`를 실행하고, 16 서버가 이 파라미터를 거부한다. 종료 코드는 1이다.
- 16 서버에서 16 client가 만든 dump를 17 `pg_restore`로 복구해도 같은 오류가 난다. dump를 만든 client와 무관하다.
- 17 client가 만든 dump를 16 client는 읽지 못한다(`unsupported version (1.16) in file header`).
- compose 스택 검증은 `apps/api/Dockerfile`의 client를 임시로 `postgresql17-client`로 바꿔 빌드한 이미지로 했다. 변경은 되돌렸다.
- backup·restore spec 3개: `backup.repository`, `restore.job`, `backup-restore-namespace-id`. 17 client는 `docker run postgres:17-alpine` 래퍼로 실행했다.
- 같은 래퍼로 16 서버 + 17 client spec을 돌리면 통과(17개)했다. 같은 dump를 직접 실행하면 종료 코드 1이다. 차이의 원인은 확인하지 못했으므로 spec 통과는 근거로 쓰지 않는다.
- 17 서버에서 `apps/api`의 전체 integration spec과 규모·부하 측정은 실행하지 않았다.

## 사용 시 주의

- `backup`·`restore` job은 `pg_dump`·`pg_restore` client의 major가 서버 major와 같아야 한다.
- client가 서버보다 낮으면 `pg_dump`가 중단한다. client가 서버보다 높으면 `backup`은 되지만 `restore`가 실패할 수 있다(위 16 서버 + 17 client).
- 현재 이미지(`apps/api/Dockerfile`)는 `postgresql16-client`만 설치한다. 17 서버에서는 `backup`·`restore`가 실패한다.
- 따라서 외부 Postgres가 16이 아니면 `backup`·`restore` job을 이 이미지로 실행할 수 없다.
- 17 서버에서 `backup`·`restore`를 쓰려면 client를 17로 바꾼 이미지를 따로 빌드해야 한다. 이 경우 16 서버에는 `restore`를 쓸 수 없다.

## CI

`계약 검증` 워크플로(`.github/workflows/contract.yml`)의 Postgres job이 16과 17을 matrix로 실행한다.
이 job은 수동 실행과 주 1회 스케줄에서만 돈다.
`pg_dump` 경로(backup·restore)는 matrix에 포함하지 않는다.

로컬에서 다른 major로 계약을 실행하려면 이미지를 환경변수로 지정한다.

```bash
STORIX_CONTRACT_PG_IMAGE=postgres:17-alpine pnpm contract --db postgres
```
