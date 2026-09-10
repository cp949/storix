#!/usr/bin/env bash
# Storix all-in-one 데모 스택(기본 http://localhost:8080)을 대상으로 실제
# 업로드/목록/복사/이동/검색/다운로드/영구 공개 발행/삭제/오류 흐름을 검증한다.
# 스택은 이미 기동되어 있어야 한다(README "기동" 절 참고).
#
# 사용법: docs/deployment/scenarios/demo-all-in-one/smoke-test.sh
# 환경 변수:
#   BASE_URL             기본 http://localhost:8080
#   CONTAINER_RUNTIME    docker 또는 podman(기본: 자동 탐지)
#   DEMO_WAS_CONTAINER   메모리 바운드 확인에 쓸 컨테이너 이름(기본: 자동 탐지)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
RUN_ID="$(date +%s)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

log() { echo "[smoke] $*"; }
fail() { echo "::error::[smoke] $*" >&2; exit 1; }

require_status() {
  local expected="$1" actual="$2" step="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$step: 기대 status=$expected, 실제=$actual"
  fi
}

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-}"
if [ -z "$CONTAINER_RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_RUNTIME=podman
  fi
fi

DIR_PATH="/reports-${RUN_ID}"
FILE_PATH="${DIR_PATH}/big.bin"
COPY_PATH="${DIR_PATH}/big-copy.bin"
MOVED_PATH="${DIR_PATH}/renamed.bin"

log "1) Nginx/React readiness 확인"
health_status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/health")
require_status 200 "$health_status" "GET /health"
root_status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/")
require_status 200 "$root_status" "GET /"

log "2) Alice 디렉터리 생성: ${DIR_PATH}"
mkdir_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/demo-api/directories" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"path\":\"${DIR_PATH}\"}")
require_status 201 "$mkdir_status" "POST /demo-api/directories"

log "3) 경로 충돌: 디렉터리 경로에 직접 업로드하면 409"
conflict_status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  "$BASE_URL/demo-api/documents/content?path=${DIR_PATH}" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/octet-stream' \
  --data-binary 'x')
require_status 409 "$conflict_status" "디렉터리 경로에 업로드(경로 충돌)"

FIXTURE_MIB=16
FIXTURE_BYTES=$((FIXTURE_MIB * 1024 * 1024))
RSS_CEILING_KB=$((FIXTURE_BYTES / 2 / 1024))  # fixture의 절반 미만이면 통버퍼링이 아니라는 신호
log "4) ${FIXTURE_MIB} MiB fixture 업로드(메모리 바운드 확인 포함)"
dd if=/dev/urandom of="$WORKDIR/big.bin" bs=1M count="$FIXTURE_MIB" status=none
expected_sha256=$(sha256sum "$WORKDIR/big.bin" | awk '{print $1}')

demo_was_container=""
if [ -n "$CONTAINER_RUNTIME" ]; then
  demo_was_container="${DEMO_WAS_CONTAINER:-$($CONTAINER_RUNTIME ps --filter 'name=demo-was' --format '{{.Names}}' | head -n1)}"
fi

rss_before=""
if [ -n "$demo_was_container" ]; then
  rss_before=$($CONTAINER_RUNTIME exec "$demo_was_container" sh -c "grep VmRSS /proc/1/status | awk '{print \$2}'" || echo "")
fi

upload_status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  "$BASE_URL/demo-api/documents/content?path=${FILE_PATH}" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/octet-stream' \
  --data-binary "@$WORKDIR/big.bin")
require_status 201 "$upload_status" "PUT /demo-api/documents/content"

if [ -n "$demo_was_container" ]; then
  rss_after=$($CONTAINER_RUNTIME exec "$demo_was_container" sh -c "grep VmRSS /proc/1/status | awk '{print \$2}'" || echo "")
  if [ -z "$rss_before" ] || [ -z "$rss_after" ]; then
    log "   경고: RSS 값을 읽지 못해 메모리 바운드 확인을 건너뜀"
  else
    rss_delta_kb=$((rss_after - rss_before))
    log "   demo-was RSS 증가량: ${rss_delta_kb} KiB(기준 ${RSS_CEILING_KB} KiB 미만)"
    if [ "$rss_delta_kb" -ge "$RSS_CEILING_KB" ]; then
      fail "업로드 스트리밍 메모리 바운드 위반: RSS가 ${rss_delta_kb} KiB 증가(기준 ${RSS_CEILING_KB} KiB)"
    fi
  fi
else
  log "   경고: 컨테이너 런타임/컨테이너를 찾지 못해 메모리 바운드 확인을 건너뜀"
fi

log "5) 목록 확인"
list_body=$(curl -sf "$BASE_URL/demo-api/documents?path=${DIR_PATH}" -H 'X-Demo-User: alice')
echo "$list_body" | jq -e --arg p "$FILE_PATH" '.items[] | select(.path == $p)' > /dev/null \
  || fail "목록에 ${FILE_PATH}가 없음: $list_body"

log "6) 검색 확인"
search_body=$(curl -sf "$BASE_URL/demo-api/documents/search?path=/&name=big.bin" -H 'X-Demo-User: alice')
echo "$search_body" | jq -e --arg p "$FILE_PATH" '.items[] | select(.path == $p)' > /dev/null \
  || fail "검색 결과에 ${FILE_PATH}가 없음: $search_body"

log "7) 복사"
copy_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/demo-api/entries/copy" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"source\":\"${FILE_PATH}\",\"destination\":\"${COPY_PATH}\"}")
require_status 201 "$copy_status" "POST /demo-api/entries/copy"

log "8) 이동/이름변경"
move_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/demo-api/entries/move" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"source\":\"${COPY_PATH}\",\"destination\":\"${MOVED_PATH}\"}")
require_status 201 "$move_status" "POST /demo-api/entries/move"

log "9) bob이 alice 경로로 이탈 요청하면 403"
escape_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/demo-api/documents/download" \
  -H 'X-Demo-User: bob' -H 'Content-Type: application/json' \
  -d "{\"path\":\"../alice${FILE_PATH}\"}")
require_status 403 "$escape_status" "POST /demo-api/documents/download(경로 이탈)"

log "10) 인가된 presigned 다운로드 발급"
download_response=$(curl -sf -X POST "$BASE_URL/demo-api/documents/download" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"path\":\"${MOVED_PATH}\"}")
presigned_url=$(echo "$download_response" | jq -r '.url')
[ -n "$presigned_url" ] && [ "$presigned_url" != "null" ] || fail "presigned url을 파싱하지 못함: $download_response"

log "11) presigned 다운로드 본문 검증"
curl -sf "$presigned_url" -o "$WORKDIR/downloaded.bin"
actual_sha256=$(sha256sum "$WORKDIR/downloaded.bin" | awk '{print $1}')
[ "$actual_sha256" = "$expected_sha256" ] || fail "presigned 다운로드 SHA-256 불일치"

log "12) presigned query 변조는 실패해야 함"
tampered_status=$(curl -s -o /dev/null -w '%{http_code}' "${presigned_url}-tampered")
if [ "$tampered_status" -lt 400 ]; then
  fail "변조된 presigned URL이 성공(${tampered_status})함"
fi

log "13) 영구 공개 링크 발행"
publish_response=$(curl -sf -X POST "$BASE_URL/demo-api/documents/publish?path=${MOVED_PATH}" -H 'X-Demo-User: alice')
public_url=$(echo "$publish_response" | jq -r '.url')
[ -n "$public_url" ] && [ "$public_url" != "null" ] || fail "공개 URL을 파싱하지 못함: $publish_response"

log "14) 인증 헤더 없이 공개 URL 접근"
curl -sf "$public_url" -o "$WORKDIR/public.bin"
public_sha256=$(sha256sum "$WORKDIR/public.bin" | awk '{print $1}')
[ "$public_sha256" = "$expected_sha256" ] || fail "공개 다운로드 SHA-256 불일치"

log "15) 발행되지 않은 임의 경로는 404(PRIVATE와 구분 불가능)"
base_public_url="${public_url%%\?path=*}"
unpublished_url="${base_public_url}?path=/never-published-${RUN_ID}.bin"
unpublished_status=$(curl -s -o /dev/null -w '%{http_code}' "$unpublished_url")
require_status 404 "$unpublished_status" "발행되지 않은 공개 경로"

log "16) 발행 취소"
unpublish_status=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE_URL/demo-api/documents/publish?path=${MOVED_PATH}" -H 'X-Demo-User: alice')
require_status 204 "$unpublish_status" "DELETE /demo-api/documents/publish"

log "17) 발행 취소 후 같은 URL은 404"
after_unpublish_status=$(curl -s -o /dev/null -w '%{http_code}' "$public_url")
require_status 404 "$after_unpublish_status" "발행 취소 후 공개 URL"

log "18) 디렉터리 재귀 삭제"
delete_status=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE_URL/demo-api/entries?path=${DIR_PATH}&recursive=true" -H 'X-Demo-User: alice')
require_status 204 "$delete_status" "DELETE /demo-api/entries"

after_delete_status=$(curl -s -o /dev/null -w '%{http_code}' \
  "$BASE_URL/demo-api/documents?path=${DIR_PATH}" -H 'X-Demo-User: alice')
require_status 404 "$after_delete_status" "삭제 후 목록 조회"

log "19) 업로드 상한 초과는 413"
dd if=/dev/urandom of="$WORKDIR/oversized.bin" bs=1M count=48 status=none
oversized_status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  "$BASE_URL/demo-api/documents/content?path=/oversized-${RUN_ID}.bin" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/octet-stream' \
  --data-binary "@$WORKDIR/oversized.bin" || echo "000")
require_status 413 "$oversized_status" "업로드 상한 초과"

log "전체 smoke test 통과"
