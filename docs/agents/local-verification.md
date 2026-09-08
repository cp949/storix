# Local Verification

이 저장소의 기여자·에이전트가 컨테이너 관련 변경을 로컬에서 검증하는 규약.
고객용 설치·실행 절차는 `README.md`.

## 런타임

- 로컬 개발·테스트는 Podman(podman-compose)을 기본으로 쓴다. 지금까지의 작업
  환경은 Docker CLI가 없는 WSL2 + podman 3.4.4 + podman-compose 1.6.0이다.
- 배포 산출물(`apps/api/Dockerfile`, `docker-compose*.yml`)은 Docker/Podman
  둘 다에서 동작해야 한다. compose-spec 표준 문법만 쓴다 — BuildKit 전용
  문법, `docker.sock` 마운트, 벤더 확장 키 금지.
- 문서의 명령 예시는 `docker compose`를 기준으로 쓰고 Podman은
  `podman-compose`로 치환 가능함을 밝힌다. `.github/workflows/*.yml`은 실
  Docker에서 돌므로 `docker compose`를 유지한다.

## compose 파일 검증

- 조합 병합 결과는 `podman-compose <-f …> config`로 확인한다. 최소 조합:
  base 단독 / +versitygw / +versitygw+postgres / +minio+postgres / +s3, 그리고
  `--profile gc|backup|restore`.
- `environment`의 숫자 리터럴은 quote한다(`STORIX_PORT: '3000'`).
  podman-compose 1.6은 unquoted 정수를 같은 서비스의 `${VAR}` 치환에 int로
  넣어 파싱에 실패한다(ADR-0004 결정 6).
- podman-compose는 `.env`의 `COMPOSE_FILE`을 읽지 않는다. 쉘에서 export한다.
- podman-compose 1.6.0 이하는 `service_completed_successfully`를 종료 코드와
  무관하게 "멈춤"으로 판정한다(containers/podman-compose#1481, 2026-07 main
  수정). `migrate` 실패가 `app` 기동으로 가려질 수 있다.
- podman 3.x는 `condition: service_healthy`를 무시한다(`WARNING: Ignored …
  condition check`). 기동 순서 검증은 Podman 4 이상 또는 Docker에서 한다.

## 실 기동 검증은 CI에서

- 이 WSL 환경에서는 podman-compose가 만드는 기본 네트워크의 서비스명 DNS가
  동작하지 않는다(`Error validating CNI config … plugin firewall does not
  support config version "1.0.0"`, `containernetworking-plugins` 0.9.1과 podman
  3.4.4 불일치, 업그레이드 경로 없음). `migrate`가 `getaddrinfo ENOTFOUND
  postgres`로 죽는다. 코드 결함이 아니다 — 재진단하지 않는다.
- 따라서 compose 실 기동은 `dev` push 시
  `.github/workflows/versity-demo-smoke.yml`(실 Docker Compose)이 검증한다.
  로컬에서는 `config` 병합 확인 + 통합 테스트로 대신한다.

## 통합 테스트(testcontainers)

`pnpm --filter @storix/api test:integration`은 testcontainers로 postgres/minio를
띄운다. Podman에서는 `podman system service`가 떠 있어야 하고 `DOCKER_HOST`가
그 소켓을 가리켜야 한다.

- `GenericContainer` + 커스텀 `Network()`는 이 환경에서 CNI 버전 불일치로
  실패한다. 회피: 커스텀 네트워크 대신 `container.getNetworkNames()[0]`과
  `getIpAddress()`로 기본 네트워크의 IP를 얻어 `withExtraHosts()`로 주입한다
  (`apps/api/src/vfs/nginx-reverse-proxy.integration-spec.ts` 참고).
- 이미지가 `EXPOSE`하는 포트를 전부 `.withExposedPorts()`에 넣고, 준비 판정은
  `Wait.forLogMessage()`로 한다. podman의 docker-compat API가 요청하지 않은
  EXPOSE 포트를 `PortBindings`에 끼워 넣어 기본 대기 전략이 타임아웃된다.
- self-signed TLS는 전역 `fetch()` + `NODE_TLS_REJECT_UNAUTHORIZED` 대신
  `node:https` `request()`에 `rejectUnauthorized: false`를 준다. Jest ESM
  환경에서 전역 dispatcher가 env var보다 먼저 초기화된다.
- 여러 에이전트가 통합 테스트를 반복 실행하면 컨테이너가 누적돼 `podman ps`가
  멈출 수 있다. 복구: `ps aux | grep -E "conmon|minio server|postgres"`의
  PID를 `kill -9` → 남은 `podman system service`도 `kill -9` →
  `podman rm -af`. 통합 테스트 대량 실패는 먼저 이 가능성을 의심한다.
