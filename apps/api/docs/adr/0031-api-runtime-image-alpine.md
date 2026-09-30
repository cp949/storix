# API runtime 이미지는 Alpine 베이스를 쓰고 쓰지 않는 번들 도구를 지운다

api ADR-0011은 최종 runtime 이미지의 HIGH·CRITICAL 취약점을 수정 가능 여부와 관계없이 CI에서 실패시킨다.
취약점 해소는 base image와 의존성의 상향 갱신으로만 한다고 정했다.
`apps/api/Dockerfile`의 이전 베이스인 `node:24.20.0-slim`(Debian 12)은 이 게이트를 통과하지 못했다.
Trivy가 OS 패키지에서 HIGH·CRITICAL을 보고했고, 대부분은 Debian이 수정판을 내지 않은 상태(`affected`·`fix_deferred`·`will_not_fix`)였다.
이 결정으로 베이스를 바꿔 api ADR-0011의 정책을 완화하지 않고 게이트를 통과시킨다.

## 결정

1. `apps/api/Dockerfile`의 모든 stage 베이스를 `node:24.20.0-alpine`으로 바꾼다. 빌드 stage도 같은 musl 환경에서 native 모듈을 설치한다.
2. runtime stage는 빌드 시점에 `apk upgrade`로 수정판이 나온 OS 패키지를 반영한다.
3. `pg_dump`·`pg_restore`는 Alpine 저장소의 `postgresql16-client`로 설치한다. 대상 Postgres major(16)와 같은 client다.
4. runtime stage에서 베이스 이미지에 번들된 npm·npx·yarn을 지운다.
   - runtime의 명령은 `node`와 corepack의 pnpm만 쓴다. compose의 `migrate`·`gc`·`backup`·`restore`가 pnpm 스크립트를 실행한다.
   - 번들 npm은 자체 `node_modules`에 취약한 모듈을 포함한다.
5. `packageManager`의 pnpm 버전은 runtime 이미지에도 들어간다. pnpm이 번들한 모듈의 취약점도 이 게이트 대상이다.

## 검토한 대안

- **Debian 12 유지와 `ignore-unfixed: true`**: 변경이 작고 glibc 호환성을 유지한다.
  수정판이 없는 OS 취약점을 게이트에서 제외하므로 api ADR-0011이 보류한 정책 완화다. 채택하지 않았다.
- **Debian 13(`node:24.20.0-trixie-slim`)**: 베이스 이미지 자체에 수정판 없는 HIGH·CRITICAL이 남아 게이트를 통과하지 못한다. 채택하지 않았다.
- **distroless Node 이미지**: shell과 패키지 관리자가 없어 pnpm 스크립트와 `pg_dump` 설치가 어렵다. 채택하지 않았다.

## 결과

- runtime은 musl libc다. native 모듈은 musl용 prebuilt 또는 빌드 stage 컴파일이 필요하다. 현재 prod native 모듈은 `better-sqlite3`이다.
- runtime 이미지에 `bash`·`curl`·npm이 없다. 컨테이너 안 진단은 busybox `sh`와 `wget`을 쓴다.
- Alpine에서 `pg_dump`·`pg_restore`를 쓰는 backup·restore와 VersityGW·Postgres 조합의 업로드·다운로드·presigned 다운로드·GC를 실제 compose 스택에서 확인했다.
- 확인하지 않은 범위: SQLite compose override 조합의 전체 스택 실행.
- Alpine이 수정판을 내지 않는 HIGH·CRITICAL이 새로 생기면 게이트가 다시 실패한다. 그때도 api ADR-0011에 따라 정책 완화 대신 갱신이나 별도 예외 정책으로 재결정한다.
