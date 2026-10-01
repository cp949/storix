#!/usr/bin/env bash
# 실행 중인 all-in-one 스택에서 demo namespace의 재개 업로드(resumable-upload)를 활성화한다.
#
# API는 시작할 때 설정의 namespace UUID가 DB에 있는지 검사한다.
# UUID는 namespace를 만들 때 정해지므로 스택을 먼저 기동한 뒤 이 스크립트를 실행한다.
#   1. demo-was가 만든 namespace의 UUID를 조회한다.
#   2. resumable/*.template로 설정을 만들어 resumable/generated/에 쓴다.
#   3. compose.resumable.yml을 겹쳐 app을 다시 기동한다.
#   4. GET /capabilities가 resumable-upload를 반환할 때까지 기다린다.
# 같은 스택에서 다시 실행해도 같은 결과다.
#
# 사용법: docs/deployment/scenarios/demo-all-in-one/enable-resumable-upload.sh
# 환경 변수:
#   ENV_FILE           compose에 넘길 --env-file(기본: 없음, 루트 .env를 자동으로 읽는다)
#   COMPOSE_CMD        기본 "docker compose"
#   DEMO_NAMESPACE     활성화할 namespace 이름(기본 demo, DEMO_WAS_NAMESPACE_NAME과 같아야 한다)
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCENARIO_DIR/../../../.." && pwd)"
SCENARIO_REL="docs/deployment/scenarios/demo-all-in-one"
GENERATED_DIR="$SCENARIO_DIR/resumable/generated"
DEMO_NAMESPACE="${DEMO_NAMESPACE:-demo}"

log() { echo "[resumable] $*"; }
fail() { echo "::error::[resumable] $*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || fail "jq가 필요하다"

cd "$REPO_ROOT"
# shellcheck disable=SC2206
compose=(${COMPOSE_CMD:-docker compose})
if [ -n "${ENV_FILE:-}" ]; then
  compose+=(--env-file "$ENV_FILE")
fi
compose+=(
  -f docker-compose.yml
  -f docker-compose.versitygw.yml
  -f docker-compose.postgres.yml
  -f "$SCENARIO_REL/compose.demo.yml"
  -f "$SCENARIO_REL/compose.resumable.yml"
)

# app 컨테이너 안에서 Storix API를 호출한다. 서비스 키는 컨테이너 환경변수를 쓴다.
storix_get() {
  "${compose[@]}" exec -T app node -e "
    fetch('http://localhost:3000$1', { headers: { Authorization: 'Bearer ' + process.env.STORIX_API_KEY } })
      .then((r) => r.text().then((t) => { process.stdout.write(t); process.exit(r.ok ? 0 : 1); }))
      .catch(() => process.exit(1));
  "
}

log "1) namespace '${DEMO_NAMESPACE}' UUID 조회"
# 목록은 page(cursor) 모드로 끝까지 순회한다. 전체 배열 응답은 namespace가 많으면 비용이 개수에 비례한다.
find_namespace_id() {
  local cursor="" page id
  while :; do
    page=$(storix_get "/api/v2/namespaces?limit=100${cursor:+&cursor=${cursor}}") || return 1
    id=$(echo "$page" | jq -r --arg n "$DEMO_NAMESPACE" '[.items[] | select(.name == $n and .accessPolicy == "PRIVATE")][0].id // empty')
    if [ -n "$id" ]; then
      echo "$id"
      return 0
    fi
    cursor=$(echo "$page" | jq -r '.nextCursor // empty')
    [ -n "$cursor" ] || return 0
  done
}
namespace_id=$(find_namespace_id) || fail "namespace 목록을 조회하지 못했다. 스택이 기동돼 있는지 확인한다"
[ -n "$namespace_id" ] || fail "PRIVATE namespace '${DEMO_NAMESPACE}'가 없다. demo-was가 기동됐는지 확인한다"
log "   ${namespace_id}"

log "2) 설정 파일 생성: ${GENERATED_DIR}"
mkdir -p "$GENERATED_DIR"
chmod 755 "$GENERATED_DIR"
for name in capabilities upload-sessions; do
  sed "s/__NAMESPACE_ID__/${namespace_id}/g" "$SCENARIO_DIR/resumable/${name}.json.template" > "$GENERATED_DIR/${name}.json"
  chmod 644 "$GENERATED_DIR/${name}.json"
  jq -e . "$GENERATED_DIR/${name}.json" >/dev/null || fail "${name}.json이 올바른 JSON이 아니다"
done

log "3) app 재기동(compose.resumable.yml 적용)"
"${compose[@]}" up -d app

log "4) capability 활성 확인"
for _ in $(seq 1 60); do
  if storix_get "/api/v2/namespaces/${namespace_id}/capabilities" 2>/dev/null | jq -e '.capabilities | index("resumable-upload")' >/dev/null 2>&1; then
    log "resumable-upload 활성화 완료"
    exit 0
  fi
  sleep 2
done
fail "120초 안에 resumable-upload가 활성화되지 않았다. app 로그를 확인한다"
