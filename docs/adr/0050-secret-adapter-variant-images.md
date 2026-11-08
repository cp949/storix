# 시크릿 어댑터를 어댑터별 변형 이미지 태그로 발행한다

## 상태

승인됨 (2026-11-08). api ADR-0039의 결정 2(`-pg16` 이미지 발행)를 대체한다.

## 배경

- 코어는 `X_REF=<scheme>://<참조>`로 비밀값을 읽고, 제공자 어댑터는 코어 밖 패키지다(api ADR-0040).
- 기본 이미지에는 어댑터가 없다. 사용자가 어댑터를 넣은 파생 이미지를 직접 만들어야 했다.
- 지금 쓰는 제공자는 둘이다.
  - OpenBao: bbcode가 자기 저장소에서 어댑터와 파생 이미지를 만들어 운영한다.
  - AWS Secrets Manager: `examples/`에 LocalStack으로만 검증한 예제가 있었다.
- 릴리즈마다 `-pg16` 이미지를 발행했지만 쓰는 사용자가 없다.

## 결정

1. 어댑터마다 변형 이미지 태그를 발행한다. 한 이미지에 어댑터 둘을 넣지 않는다.

   | 태그               | 내용                                     |
   | ------------------ | ---------------------------------------- |
   | `vX.Y.Z`, `latest` | 기준 이미지. 어댑터 없음                 |
   | `vX.Y.Z-bao`       | 기준 이미지 + OpenBao 어댑터             |
   | `vX.Y.Z-aws`       | 기준 이미지 + AWS Secrets Manager 어댑터 |
   - 변형에 `latest-bao` 같은 이동 태그를 두지 않는다.

2. 어댑터를 `packages/secret-source-bao`, `packages/secret-source-aws`로 둔다.
   - 패키지명은 `storix-secret-source-bao`, `storix-secret-source-aws`다. bao는 bbcode가 쓰는 이름을 유지한다. aws는 예제 이름(`-aws-example`)에서 바꾼다.
   - 루트 workspace에서 제외하고 패키지마다 독립 lockfile로 설치한다. 어댑터 의존성이 해당 변형 이미지에만 들어간다.
   - npm에 공개하지 않는다.
3. 변형 Dockerfile은 패키지 디렉터리에 둔다. 빌드 인자 `STORIX_BASE_IMAGE`로 기준 이미지를 받으며 기본값이 없다.
4. 릴리즈는 기준 이미지·Release job 뒤에 변형 job을 `needs`로 잇는다.
   - 변형은 방금 push한 기준 이미지 위에 빌드한다.
   - 변형은 push 전에 이미지 안 스모크(어댑터 로드와 `X_REF` 해석)를 통과해야 한다.
   - 변형이 실패하면 워크플로는 실패로 끝나고 기준 이미지와 Release는 발행된 상태로 남는다. "Re-run failed jobs"로 변형 job만 다시 돌린다.
5. PR과 `dev` push에서도 어댑터 단위 테스트, 변형 이미지 스모크, 변형 이미지 Trivy 스캔을 실행한다.
6. `-pg16` 이미지 발행을 중단한다. `PG_CLIENT_MAJOR` 빌드 인자는 남긴다.
   - 새 변형에 pg16을 곱하지 않는다.
   - GHCR의 기존 `-pg16` 태그는 지우지 않는다.

## 대안

- **어댑터 둘을 한 이미지에 넣는 `-secrets` 태그**:
  - 쓰지 않는 제공자의 SDK와 취약점이 모든 사용자 이미지에 들어간다.
- **사용자 파생 이미지 유지**:
  - 어댑터와 Storix 버전이 어긋나도 빌드 시점에 드러나지 않는다.
  - 제공자마다 같은 Dockerfile을 사용자가 반복해 만든다.
- **어댑터를 루트 workspace에 편입**:
  - 루트 lockfile에 AWS SDK가 들어간다.
  - 변형 이미지가 패키지 단위 `--frozen-lockfile` 설치를 쓰기 어렵다.
- **기준 이미지·변형을 한 job에서 발행**:
  - 변형 실패가 Release 생성을 막거나, 변형만 빠진 채 성공으로 끝난다.

## 결과

- 첫 변형 이미지는 이 변경이 들어간 다음 릴리즈에서 나온다.
- 변형 이미지는 기준 이미지와 같은 커밋에서 만든다.
- 변형 job이 실패하면 기준 이미지와 Release가 먼저 공개된 상태가 된다. 릴리즈 노트에 이 사실을 적는다.
- 변형 push가 일부만 성공해도 태그를 지우지 않는다. 재실행이 같은 태그를 덮어쓴다.
- 보안 게이트는 변형 이미지도 대상에 넣는다. HIGH 이상 취약점은 차단한다.
- aws 어댑터 패키지명이 바뀌었다. `STORIX_SECRET_ADAPTERS=storix-secret-source-aws-example`을 쓴 배포는 `storix-secret-source-aws`로 바꾼다.
- bbcode-storix의 파생 이미지 제거는 이 결정에 포함하지 않는다.
- Postgres 16 서버는 지원 대상으로 선언하지 않는다. 16 client가 필요하면 `--build-arg PG_CLIENT_MAJOR=16`으로 소스 빌드한다.
- GitHub Actions에서 변형 job은 실제 릴리즈 전에 실행해 확인하지 않았다.
