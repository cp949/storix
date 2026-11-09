# TRP-014 독립 설치 pnpm 12는 자기 설치본의 `pnpm`이 placeholder로 남아 turbo가 `Exec format error`로 실패한다

- 상태: ACTIVE
- 적용 조건: pnpm 12를 corepack이 아닌 독립 설치(`~/.local/share/pnpm/pnpm` 등)로 쓰고, `packageManager`가 `pnpm@12.x`인 저장소에서 `pnpm typecheck`·`lint`·`build`·`test`(`turbo run`)를 실행할 때.

## 오해하기 쉬운 신호

- `pnpm -v`는 `12.18.0`을 출력하고 `pnpm install --frozen-lockfile`도 성공한다.
- `pnpm --filter @cp949/storix-api typecheck`처럼 turbo를 거치지 않는 명령은 통과한다.
- `pnpm typecheck`(turbo)는 캐시된 패키지는 통과하고, 캐시 미스인 패키지에서만 `unable to spawn child process: Exec format error (os error 8)`로 실패한다.
- 실패 메시지에 어느 실행 파일인지 나오지 않아 소스·lockfile 문제로 오해하기 쉽다.

## 원인

확인한 사실:

- pnpm 12는 `packageManager`와 lockfile의 `packageManagerDependencies`에 맞춰 `~/.local/share/pnpm/.tools/pnpm/12.18.0/`에 자기 자신을 설치하고, 스크립트 실행 PATH 앞에 그 `bin/`을 둔다.
- 이 설치는 lifecycle script를 돌리지 않는다. 네이티브 바이너리로 교체되어야 할 `bin/pnpm`이 shebang 없는 placeholder 텍스트로 남는다(pnpm `install.js` 주석: 스크립트를 막은 설치는 placeholder를 유지하고, 셸이 실행할 때만 Node를 거쳐 동작한다).
- 셸은 shebang 없는 파일을 `sh`로 대신 실행하지만, turbo(Rust)는 `execve`로 직접 실행해 `ENOEXEC`가 난다.

해석(미확인): corepack 경로에서는 이 문제가 없다. 이 저장소의 Docker 빌드와 로컬 `corepack` 경로에서는 통과했다.

## 탐지/회피

- 탐지: `pnpm exec sh -c 'which -a pnpm'`의 첫 줄이 `.tools/pnpm/12.x/bin/pnpm`이고 `file -L` 결과가 `ASCII text`다.
- 회피: corepack의 pnpm이 PATH 앞에 오게 한다. 예: `PATH=$(dirname $(command -v node)):$PATH`로 nvm의 corepack shim을 앞세운다. `corepack enable`로 만든 `pnpm`은 `packageManager`의 12.x를 내려받아 쓴다.
- CI와 Docker는 `corepack enable`을 쓰므로 영향이 없다(`release.yml`, `apps/api/Dockerfile` 등).
