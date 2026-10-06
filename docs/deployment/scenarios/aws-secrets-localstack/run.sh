#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
readonly BASE_IMAGE="storix-secret-source-localstack-base:local"
readonly APP_IMAGE="storix-secret-source-localstack-app:local"
readonly API_KEY="localstack-example-api-key-0123456789abcdef"
readonly MASTER_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

skip_build=0
keep_project=0
for option in "$@"; do
  case "$option" in
    --skip-build) skip_build=1 ;;
    --keep) keep_project=1 ;;
    *)
      printf '사용법: bash docs/deployment/scenarios/aws-secrets-localstack/run.sh [--skip-build] [--keep]\n' >&2
      exit 2
      ;;
  esac
done
cd "$ROOT"

token="${LOCALSTACK_AUTH_TOKEN:-}"
if [[ -z "$token" ]]; then
  if ! command -v pass >/dev/null 2>&1; then
    printf 'LocalStack Auth Token이 없고 pass 명령을 찾지 못했다\n' >&2
    exit 1
  fi
  if ! token="$(pass show localstack/auth-token 2>/dev/null)" || [[ -z "$token" ]]; then
    printf 'pass에서 LocalStack Auth Token을 읽지 못했다\n' >&2
    exit 1
  fi
fi

for name in ${!STORIX_@}; do unset "$name"; done
for name in ${!AWS_@}; do unset "$name"; done
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME

readonly PROJECT="storix-secret-source-localstack-$$"
readonly PORT="$((20000 + ($$ % 30000)))"
readonly EMPTY_ENV="$(mktemp)"
export LOCALSTACK_AUTH_TOKEN="$token"
unset token
export STORIX_BASE_IMAGE="$BASE_IMAGE"
export STORIX_APP_IMAGE="$APP_IMAGE"
export STORIX_LOCALSTACK_DEMO_PORT="$PORT"
export STORIX_PUBLISH_HOST=127.0.0.1
export STORIX_PUBLISH_PORT="$PORT"
export STORIX_LOCALSTACK_API_KEY="$API_KEY"
export STORIX_EXAMPLE_MASTER_KEY="$MASTER_KEY"
export STORIX_STORAGE_ACCESS_KEY=storix-example
export STORIX_STORAGE_SECRET_KEY=storix-example-secret
export STORIX_STORAGE_BUCKET=storix-localstack-example

compose() {
  docker compose \
    --project-name "$PROJECT" \
    --env-file "$EMPTY_ENV" \
    -f docker-compose.yml \
    -f docker-compose.sqlite.yml \
    -f docker-compose.versitygw.yml \
    -f docs/deployment/scenarios/aws-secrets-localstack/compose.localstack.yml \
    "$@"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" -eq 0 && "$keep_project" -eq 1 ]]; then
    unlink "$EMPTY_ENV" 2>/dev/null || true
    printf '프로젝트 유지: project=%s\n' "$PROJECT"
    exit 0
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  unlink "$EMPTY_ENV" 2>/dev/null || true
  if [[ "$status" -eq 0 ]]; then
    printf '정리 완료: project=%s\n' "$PROJECT"
  else
    printf '예제 실패 또는 정리 실패: project=%s\n' "$PROJECT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$skip_build" -eq 1 ]]; then
  docker image inspect "$BASE_IMAGE" >/dev/null
  docker image inspect "$APP_IMAGE" >/dev/null
else
  docker build --file apps/api/Dockerfile --tag "$BASE_IMAGE" .
  docker build \
    --file examples/secret-source-aws/Dockerfile \
    --build-arg "STORIX_BASE_IMAGE=$BASE_IMAGE" \
    --tag "$APP_IMAGE" .
fi

compose up -d --wait --wait-timeout 90 localstack
compose run --rm --no-deps secret-init
printf 'LocalStack Secret 초기화 완료\n'
compose up -d --wait --wait-timeout 120 app

readonly MIGRATE_CONTAINER="$(compose ps --all -q migrate)"
readonly MIGRATE_EXIT="$(docker inspect --format '{{.State.ExitCode}}' "$MIGRATE_CONTAINER")"
if [[ "$MIGRATE_EXIT" != "0" ]]; then
  printf 'SQLite migration이 0으로 끝나지 않았다\n' >&2
  exit 1
fi

readonly BASE_URL="http://127.0.0.1:$PORT"
compose exec -T app node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const loader = await import(pathToFileURL("/repo/apps/api/dist/secrets/secret-adapter-loader.js"));
  const [source] = await loader.loadSecretAdapters(["storix-secret-source-aws-example"]);
  if (source.scheme !== "aws-sm") process.exit(1);
' >/dev/null
node --input-type=module - "$BASE_URL" "$API_KEY" <<'NODE'
import assert from 'node:assert/strict';

const [baseUrl, apiKey] = process.argv.slice(2);
const authorized = await fetch(`${baseUrl}/api/v2/namespaces`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
assert.equal(authorized.status, 200, '정상 키 요청은 200이어야 한다');
assert.ok(Array.isArray(await authorized.json()), '정상 응답은 배열이어야 한다');

const wrongKey = await fetch(`${baseUrl}/api/v2/namespaces`, {
  headers: { Authorization: 'Bearer localstack-wrong-key' },
});
assert.equal(wrongKey.status, 401, '다른 키 요청은 401이어야 한다');

const noKey = await fetch(`${baseUrl}/api/v2/namespaces`);
assert.equal(noKey.status, 401, '키 없는 요청은 401이어야 한다');
console.log('인증 확인: 정상 키 200, 다른 키 401, 키 없음 401');
NODE

readonly APP_CONTAINER="$(compose ps -q app)"
readonly APP_ENV="$(docker inspect --format '{{json .Config.Env}}' "$APP_CONTAINER")"
if [[ "$APP_ENV" == *"STORIX_API_KEY=$API_KEY"* || "$APP_ENV" == *LOCALSTACK_AUTH_TOKEN=* ]]; then
  printf 'Storix Config.Env에 테스트 키 또는 Auth Token이 있다\n' >&2
  exit 1
fi

if ! proc_environment_result="$(printf '%s' "$API_KEY" | compose exec -T -i app node -e '
  import { readFileSync } from "node:fs";
  let key = "";
  for await (const chunk of process.stdin) key += chunk;
  const initialEnvironment = readFileSync("/proc/1/environ", "utf8").split("\0");
  const leaked = initialEnvironment.includes(`STORIX_API_KEY=${key}`);
  process.stdout.write(leaked ? "leaked" : "absent");
  process.exitCode = leaked ? 1 : 0;
  ' )"; then
  printf 'Storix Node 프로세스의 /proc/1/environ에 테스트 키가 있다\n' >&2
  exit 1
fi
if [[ "$proc_environment_result" != "absent" ]]; then
  printf 'Storix Node 프로세스 환경을 확인할 수 없었다\n' >&2
  exit 1
fi

readonly LOGS="$(compose logs --no-color 2>/dev/null)"
if [[ "$LOGS" == *"$API_KEY"* || "$LOGS" == *"$LOCALSTACK_AUTH_TOKEN"* ]]; then
  printf '예제 컨테이너 로그에 테스트 API 키 또는 Auth Token이 있다\n' >&2
  exit 1
fi

printf '예제 검증 완료: project=%s url=%s\n' "$PROJECT" "$BASE_URL"
