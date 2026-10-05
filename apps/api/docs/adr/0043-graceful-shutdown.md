# API 서버가 종료 신호를 받으면 진행 중 요청을 기다린 뒤 종료한다

## 상태

승인됨 (2026-10-05)

## 배경

`apps/api/src/main.ts`는 종료 신호를 처리하지 않았다(GitHub 이슈 #27).
`enableShutdownHooks`, `SIGTERM`·`SIGINT` 핸들러, `onApplicationShutdown`이 없었다.

- 컨테이너에서 node가 PID 1이다(`apps/api/Dockerfile`의 `CMD ["node", ...]`).
- 핸들러가 없는 PID 1 프로세스는 SIGTERM을 무시한다.
- `docker stop`은 기본 10초를 기다린 뒤 SIGKILL을 보낸다.
- 진행 중 요청은 응답 없이 끊긴다.
- `DataSource.destroy()`는 `@nestjs/typeorm`의 `onApplicationShutdown`에서 실행되는데 서버에서는 실행되지 않았다.

실측(2026-10-05, Docker 29.8.0, `node:24.20.0-alpine`):

- 핸들러가 없는 node PID 1에 `docker stop`을 보내면 10.2초 뒤 exit 137로 끝났다.
- 이 변경 이후 이미지에서 유휴 상태 `docker stop`은 0.27초 뒤 exit 0으로 끝났다.
- `STORIX_SHUTDOWN_TIMEOUT_SECONDS=3`에서 본문을 반쯤 보낸 요청이 열려 있을 때 `docker stop`은 3.3초 뒤 exit 1로 끝났고 그 요청은 연결 재설정(`ECONNRESET`)을 받았다.

강제 종료로 남는 상태는 GC 1회로 복구된다.

- 업로드 세션의 RESERVED part와 FINALIZING 세션은 GC가 되돌리거나 만료시킨다.
- 객체만 올라가고 DB에 커밋되지 않은 orphan 객체는 GC가 `STORIX_ORPHAN_GRACE_PERIOD` 뒤 삭제한다.
- 완료되지 않은 multipart upload의 조각은 orphan 객체 단계가 보지 못한다. 별도 GC 단계가 abort한다(api ADR-0045).
- Postgres advisory lock은 연결이 끊기면 서버가 해제한다.
- SQLite 쿼리 게이트(api ADR-0025)는 메모리 상태뿐이라 디스크에 남는 상태가 없다.

복구되지 않는 것은 진행 중 요청의 응답과 정리되지 않은 DB 연결이다.
데이터 손상 경로는 확인하지 못했다.

## 결정

- `main.ts`가 `installGracefulShutdown`(`src/common/graceful-shutdown.ts`)으로 `SIGTERM`·`SIGINT` 핸들러를 직접 등록한다.
- 신호를 받으면 `app.close()`를 호출한다.
  - 새 연결을 받지 않는다.
  - 진행 중 요청이 끝나길 기다린다.
  - 모듈 종료 훅이 실행되어 `DataSource.destroy()`가 돈다.
- 종료 코드:
  - `app.close()`가 상한 안에 끝나면 0이다.
  - 상한을 넘기면 `closeAllConnections()`로 남은 연결을 끊고 1이다.
  - `app.close()`가 실패하면 1이다.
  - 종료 중 신호가 다시 오면 기다리지 않고 1이다.
- 상한은 환경변수 `STORIX_SHUTDOWN_TIMEOUT_SECONDS`(기본 25, 1~3600)다.
  - 다른 정수 변수와 같은 파서(`parsePositiveInt`)를 쓴다. 0, 음수, 비정수는 부팅을 거부한다.
- compose `app` 서비스에 `stop_grace_period: 30s`를 둔다.
  - `docker stop`이 SIGKILL을 보내기 전 대기 시간이다. 앱 상한보다 길어야 한다.
  - `STORIX_SHUTDOWN_TIMEOUT_SECONDS`를 올리면 `stop_grace_period`도 함께 올린다.
- Nest `enableShutdownHooks()`는 쓰지 않는다.
  - 핸들러를 이중으로 등록하게 된다.
  - 상한을 줄 수 없다.
  - `app.close()` 뒤 같은 신호를 다시 보내 종료한다.
- compose `init: true`와 tini는 쓰지 않는다. 핸들러를 등록하면 PID 1에서도 SIGTERM에 반응하고, 이 프로세스는 좀비를 만들 자식 프로세스를 두지 않는다.
- 종료 중 `/health/ready`를 503으로 바꾸지 않는다. 단일 `app` 인스턴스 구성이고 로드밸런서 전환을 전제한 구성이 저장소에 없다.

## 한계

- 상한보다 오래 걸리는 요청은 끊긴다.
  - 조건부 raw 업로드와 재개 업로드 조각 요청은 `STORIX_MUTATION_MAX_UPLOAD_SECONDS`(기본 86400초)까지 걸릴 수 있다.
  - 끊긴 요청의 클라이언트는 응답을 받지 못한다. 조건부 요청은 같은 `Idempotency-Key`로 다시 보낸다.
  - 서버에 남은 상태는 위 GC가 정리한다.
- 상한을 넘겨 종료하면 `DataSource.destroy()`가 실행되지 않을 수 있다. 연결 정리는 프로세스 종료와 소켓 close에 맡겨진다.
- 이 결정은 API 서버(`main.ts`)에만 적용한다. 아래 "대안"의 잡 진입점은 범위 밖이다.

## 대안

- **`enableShutdownHooks()`만 사용**: 상한 없이 무기한 기다리고, 상한은 `docker stop`의 SIGKILL에 맡긴다. 종료 코드와 로그로 원인을 구분할 수 없다.
- **`init: true` 또는 tini**: compose 파일과 사용자 override마다 설정해야 한다. 컨테이너 밖 실행에는 효과가 없다.
- **gc/backup/restore 잡 진입점에 같은 처리 추가**: 이번에 제외했다.
  - 잡은 one-shot이고 복구 경로가 이미 있다. gc는 `gc_cursor`와 멱등 삭제, backup은 `.partial` 디렉터리, restore는 같은 백업으로 재실행이다.
  - 잡은 `pnpm --filter ... run`으로 실행되는데 `pnpm run`은 SIGTERM을 받으면 자신만 종료하고 자식 node에 전달하지 않았다(2026-10-05, pnpm 10.28.0 실측). 잡 처리를 추가하려면 이 전달 문제를 함께 풀어야 한다.
- **종료 중 readiness 503**: 로드밸런서 전환을 전제한 구성이 없어 얻는 것이 없다.

## 결과

- `docker compose stop`·`up -d --build`로 `app`을 교체할 때 진행 중 요청이 끝난 뒤 종료한다. 유휴 상태에서는 즉시 끝난다.
- 새 환경변수 `STORIX_SHUTDOWN_TIMEOUT_SECONDS`가 추가된다.
- compose `app` 서비스의 정지 대기 시간이 10초에서 30초로 늘어난다. 진행 중 요청이 있으면 `docker stop`이 최대 그만큼 걸린다.
- 종료 동작은 HTTP 계약이 아니라서 `apps/contract`에 계약을 추가하지 않았다. `test/graceful-shutdown.integration-spec.ts`가 실제 `dist/main.js` 프로세스로 검증한다.
