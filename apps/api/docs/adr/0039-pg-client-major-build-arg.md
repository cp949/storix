# `pg_dump` client major를 빌드 인자로 정하고 기본값을 17로 한다

## 상태

승인됨 (2026-10-02)

## 배경

- `backup`·`restore` job은 이미지의 `pg_dump`·`pg_restore`를 실행한다.
- 이전 이미지는 `postgresql16-client`만 설치했다.
- 첫 사용처의 Postgres 서버는 17이다.

2026-10-02에 실제 실행한 결과:

| client | 서버 | 검사                                         | 결과                                                                     |
| ------ | ---- | -------------------------------------------- | ------------------------------------------------------------------------ |
| 16     | 17   | backup                                       | `pg_dump`가 `server version mismatch`로 중단한다.                        |
| 17     | 17   | backup → 빈 대상 restore → 파일 SHA-256 비교 | 통과한다.                                                                |
| 17     | 16   | backup                                       | 통과한다.                                                                |
| 17     | 16   | restore                                      | `unrecognized configuration parameter "transaction_timeout"`로 실패한다. |
| 16     | 16   | backup → 빈 대상 restore → 파일 SHA-256 비교 | 통과한다.                                                                |

17 client로 16 서버를 복구할 때의 실패는 dump를 만든 client와 무관하다.
세부 결과는 `docs/deployment/postgres-versions.md`에 둔다.
단일 client로는 16·17 서버의 backup·restore를 모두 처리할 수 없다.

## 결정

1. `apps/api/Dockerfile`에 빌드 인자 `PG_CLIENT_MAJOR`를 둔다.
   - 기본값은 17이다.
   - `postgresql${PG_CLIENT_MAJOR}-client`를 설치한다.
2. 릴리즈는 두 이미지를 발행한다.
   - `ghcr.io/cp949/storix:vX.Y.Z`와 `:latest`: client 17.
   - `ghcr.io/cp949/storix:vX.Y.Z-pg16`: client 16.
3. 개발용 Postgres 컨테이너(`docker-compose.postgres.yml`)를 17로 올린다.
   기본 이미지의 client major와 맞춘다.
4. 지원 Postgres major 범위는 선언하지 않는다.
   검증한 조합만 `docs/deployment/postgres-versions.md`에 기록한다.

## 대안

- **client 17만 제공**:
  - 16 서버의 restore가 실패해 채택하지 않았다.
- **한 이미지에 client 16·17을 설치하고 서버 버전으로 선택**:
  - Alpine 패키지가 같은 경로를 쓰는지는 확인하지 않았다.
  - client 선택 코드도 필요해 채택하지 않았다.
- **client 16 유지와 17 서버 backup 미지원**:
  - 첫 사용처가 17이므로 채택하지 않았다.

## 결과

- 기본 이미지는 17 서버용이다.
- 16 서버는 `-pg16` 이미지를 쓰거나 `--build-arg PG_CLIENT_MAJOR=16`으로 빌드한다.
- 기존 1.0.x 이미지는 client 16이다.
  16 서버 배포가 새 기본 이미지로 갱신하면 restore가 실패한다.
  이 결정 당시 기존 사용자는 없었다.
- 18 이상 서버도 해당 client로 빌드할 수 있다.
  이 조합은 검증하지 않았다.
- 이미지 보안 게이트(`security.yml`)는 기본 이미지(client 17)만 빌드한다.
  `-pg16` 변형은 게이트 대상이 아니다.
- GitHub Actions에서 `release.yml`의 변형 빌드 단계는 실행해 확인하지 않았다.
