# Postgres 버전 검증 이력

Storix는 지원 Postgres major 범위를 선언하지 않는다.
이 문서는 실행 기록이 있는 조합만 다룬다.
기록에 없는 조합은 검증하지 않았다.

| 대상                                        | 기본 major |
| ------------------------------------------- | ---------- |
| 개발용 Compose의 Postgres                   | 17         |
| 운영 이미지의 `pg_dump`·`pg_restore` client | 17         |
| API 통합 테스트·로컬 계약 runner            | 16         |
| CI 계약 matrix                              | 16·17      |

서버·client 선택은 api ADR-0039를 따른다.

## 검증 결과

아래는 2026-10-02의 실행 기록이다.
이미지 client 열은 `apps/api/Dockerfile`의 `PG_CLIENT_MAJOR` 설정이다.

| 서버  | 이미지 client | 실행한 것                                                     | 결과                                                                |
| ----- | ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| 17.11 | —             | 계약 검증 `pnpm contract --db postgres`(70개, migration 포함) | 통과 70, 실패 0                                                     |
| 17.11 | 17.11         | Compose backup → 빈 대상 restore → 파일 SHA-256 비교          | 통과                                                                |
| 16.15 | 16.15         | 위와 같음                                                     | 통과                                                                |
| 17.11 | 16.15         | backup·restore integration spec 3개(17개 테스트)              | 통과 2, 실패 15 (`pg_dump` 버전 불일치)                             |
| 16.15 | 17.11         | Compose backup                                                | 통과                                                                |
| 16.15 | 17.11         | Compose restore                                               | 실패 (`unrecognized configuration parameter "transaction_timeout"`) |

실패 원인:

- 17 서버 + 16 client: `pg_dump: error: aborting because of server version mismatch`다.
- 16 서버 + 17 client: `pg_restore`가 `SET transaction_timeout = 0;`을 실행한다.
- 16 서버는 이 파라미터를 거부한다. 종료 코드는 1이다.
- 16 client가 만든 dump도 17 `pg_restore`로 복구하면 같은 오류가 난다.
- 17 client가 만든 dump는 16 client가 읽지 못한다.
- 해당 오류는 `unsupported version (1.16) in file header`다.

Spec 실행 조건과 한계:

- backup·restore spec은 `backup.repository`, `restore.job`, `backup-restore-namespace-id`다.
- 17 client는 `docker run postgres:17-alpine` 래퍼로 실행했다.
- 같은 래퍼의 16 서버 + 17 client spec은 17개가 통과했다.
- 같은 dump를 직접 복구하면 종료 코드는 1이었다.
- 결과 차이의 원인은 확인하지 못했다.
- 이 spec 통과를 호환성 근거로 사용하지 않는다.
- 17 서버의 `apps/api` 전체 integration spec과 규모·부하 측정은 실행하지 않았다.

## 사용 시 주의

- backup·restore 이미지의 client major는 서버 major와 맞춘다.
- client가 서버보다 낮으면 backup이 중단된다.
- client가 서버보다 높으면 backup이 성공해도 restore가 실패할 수 있다.
- 기본 이미지의 client major는 17이다.
- 16 서버는 `-pg16` 이미지 또는 `--build-arg PG_CLIENT_MAJOR=16`을 사용한다(api ADR-0039).
- 18 이상 서버는 검증하지 않았다.

## CI

- `.github/workflows/contract.yml`의 Postgres job은 16·17 matrix를 실행한다.
- 실행 조건은 수동 실행과 주 1회 스케줄이다.
- backup·restore의 `pg_dump`·`pg_restore` 경로는 이 matrix에 포함하지 않는다.

로컬 계약 검증에서 major를 바꾸려면 이미지를 환경 변수로 지정한다.

```bash
STORIX_CONTRACT_PG_IMAGE=postgres:17-alpine pnpm contract --db postgres
```
