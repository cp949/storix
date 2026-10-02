# `pg_dump` client major를 빌드 인자로 정하고 기본값을 17로 한다

## 상태

승인됨 (2026-10-02)

## 배경

- `backup`·`restore` job은 이미지의 `pg_dump`·`pg_restore`를 실행한다. 이전 이미지는 `postgresql16-client` 하나만 설치했다.
- 첫 사용처의 Postgres 서버는 17이다.
- 2026-10-02에 실제로 실행해 확인한 결과다.
  - client 16 + 서버 17: `pg_dump`가 `server version mismatch`로 중단한다.
  - client 17 + 서버 17: backup → 빈 대상 restore → 파일 SHA-256 비교가 통과한다.
  - client 17 + 서버 16: backup은 통과하지만 restore는 `unrecognized configuration parameter "transaction_timeout"`로 실패한다. dump를 만든 client와 무관하다.
  - client 16 + 서버 16: backup → 빈 대상 restore → 파일 SHA-256 비교가 통과한다.
- 결과 표는 `docs/deployment/postgres-versions.md`에 있다.
- 단일 client로 16·17 서버를 모두 다룰 수 없다.

## 결정

1. `apps/api/Dockerfile`에 빌드 인자 `PG_CLIENT_MAJOR`를 둔다. 기본값은 17이고 `postgresql${PG_CLIENT_MAJOR}-client`를 설치한다.
2. 릴리즈는 두 이미지를 발행한다.
   - `ghcr.io/cp949/storix:vX.Y.Z`와 `:latest`: client 17.
   - `ghcr.io/cp949/storix:vX.Y.Z-pg16`: client 16.
3. 개발용 Postgres 컨테이너(`docker-compose.postgres.yml`)를 17로 올려 기본 이미지와 맞춘다.
4. Storix가 지원하는 Postgres major 범위는 선언하지 않는다. 검증한 조합만 `postgres-versions.md`에 기록한다.

## 대안

- **client를 17로 올리고 변형을 두지 않는다**: 16 서버의 restore가 실패한다. 채택하지 않았다.
- **한 이미지에 16·17 client를 모두 설치하고 서버 버전으로 고른다**: Alpine 패키지가 같은 경로를 쓰는지 확인하지 않았고 코드 변경이 필요하다. 채택하지 않았다.
- **client 16을 유지하고 17 서버는 backup 미지원으로 문서화한다**: 첫 사용처가 17이다. 채택하지 않았다.

## 결과

- 기본 이미지는 17 서버용이다. 16 서버는 `-pg16` 이미지를 쓰거나 `--build-arg PG_CLIENT_MAJOR=16`으로 빌드한다.
- 기존 1.0.x 이미지는 client 16이다. 이 이미지를 쓰는 16 서버 배포가 새 기본 이미지로 올리면 restore가 실패한다. 이 결정 시점에 기존 사용자는 없다.
- 18 이상의 서버는 해당 client로 같은 방식으로 빌드하면 되지만 검증하지 않았다.
- 컨테이너 이미지 보안 게이트(`security.yml`)는 기본 이미지(client 17)만 빌드한다. `-pg16` 변형은 게이트 대상이 아니다.
- 확인하지 않은 범위: GitHub Actions에서 `release.yml`의 변형 빌드 단계 실행.
