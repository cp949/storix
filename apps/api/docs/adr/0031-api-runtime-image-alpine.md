# API runtime 이미지는 Alpine 베이스를 쓰고 쓰지 않는 번들 도구를 지운다

api ADR-0011은 최종 runtime 이미지의 HIGH·CRITICAL 취약점을 CI에서 실패시킨다.
수정 가능 여부는 예외 조건이 아니다.
취약점은 base image와 의존성을 상향 갱신해 해소한다.

이전 베이스는 `node:24.20.0-slim`(Debian 12)이었다.
Trivy가 OS 패키지의 HIGH·CRITICAL을 보고해 게이트를 통과하지 못했다.
대부분 Debian 수정판이 없는 상태였다.
상태는 `affected`·`fix_deferred`·`will_not_fix`였다.

이 결정은 베이스를 바꿔 api ADR-0011의 정책을 유지한 채 게이트를 통과시킨다.

## 결정

1. `apps/api/Dockerfile`의 모든 stage 베이스를 `node:24.20.0-alpine`으로 바꾼다.
   빌드 stage도 같은 musl 환경에서 native 모듈을 설치한다.
2. runtime stage는 빌드 시점에 `apk upgrade`로 OS 패키지 수정판을 반영한다.
3. `pg_dump`·`pg_restore`는 Alpine의 `postgresql<major>-client`로 설치한다.
   client major는 대상 Postgres major와 맞춘다.
   빌드 인자 지정은 api ADR-0039를 따른다.
4. runtime stage에서 번들 npm·npx·yarn을 지운다.
   - runtime 명령은 `node`와 corepack의 pnpm만 쓴다.
   - compose의 `migrate`·`gc`·`backup`·`restore`는 pnpm 스크립트를 실행한다.
   - 번들 npm은 자체 `node_modules`에 취약한 모듈을 포함한다.
5. `packageManager`의 pnpm 버전은 runtime 이미지에도 포함한다.
   pnpm이 번들한 모듈의 취약점도 게이트 대상이다.

## 검토한 대안

- **Debian 12 유지와 `ignore-unfixed: true`**:
  - 변경이 작고 glibc 호환성을 유지한다.
  - 수정판이 없는 OS 취약점을 게이트에서 제외한다.
  - api ADR-0011이 보류한 정책 완화이므로 채택하지 않았다.
- **Debian 13(`node:24.20.0-trixie-slim`)**:
  - 베이스 이미지에 수정판 없는 HIGH·CRITICAL이 남는다.
  - 게이트를 통과하지 못해 채택하지 않았다.
- **distroless Node 이미지**:
  - shell과 패키지 관리자가 없다.
  - pnpm 스크립트 실행과 `pg_dump` 설치가 어려워 채택하지 않았다.

## 결과

- runtime은 musl libc를 쓴다.
  native 모듈은 musl용 prebuilt나 빌드 stage 컴파일이 필요하다.
  이 결정 당시 prod native 모듈은 `better-sqlite3`이다.
- runtime 이미지에는 `bash`·`curl`·npm이 없다.
  컨테이너 안 진단은 busybox `sh`와 `wget`을 쓴다.
- 실제 compose 스택에서 다음 경로를 확인했다.
  - Alpine의 `pg_dump`·`pg_restore`를 쓰는 backup·restore.
  - VersityGW·Postgres 조합의 업로드·다운로드·presigned 다운로드·GC.
- SQLite compose override 조합의 전체 스택은 실행하지 않았다.
- Alpine에 수정판 없는 HIGH·CRITICAL이 새로 생기면 게이트가 다시 실패한다.
  api ADR-0011에 따라 갱신하거나 별도 예외 정책을 결정해야 한다.
  이 결정만으로 게이트 정책을 완화하지 않는다.
