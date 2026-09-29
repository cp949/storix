#!/usr/bin/env bash
# Storix all-in-one 데모 스택(기본 http://localhost:8080)을 대상으로 실제
# 업로드/목록/복사/이동/검색/다운로드/영구 공개 발행/삭제/오류 흐름을 검증한다.
# 스택은 이미 기동되어 있어야 한다(README "기동" 절 참고).
#
# 사용법: docs/deployment/scenarios/demo-all-in-one/smoke-test.sh
# 환경 변수:
#   BASE_URL             기본 http://localhost:8080
#   CONTAINER_RUNTIME    docker 또는 podman(기본: 자동 탐지)
#   DEMO_WAS_CONTAINER   RSS 기록에 쓸 컨테이너 이름(기본: 자동 탐지)
# 20단계(재개 업로드)는 enable-resumable-upload.sh로 활성화한 스택에서만 실행하고, 비활성이면 건너뛴다.
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
require_status 204 "$mkdir_status" "POST /demo-api/directories"

log "3) 경로 충돌: 디렉터리 경로에 직접 업로드하면 409"
conflict_status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  "$BASE_URL/demo-api/documents/content?path=${DIR_PATH}" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/octet-stream' \
  --data-binary 'x')
require_status 409 "$conflict_status" "디렉터리 경로에 업로드(경로 충돌)"

FIXTURE_MIB=16
FIXTURE_BYTES=$((FIXTURE_MIB * 1024 * 1024))
log "4) ${FIXTURE_MIB} MiB fixture 업로드(RSS 기록 포함)"
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
    log "   경고: RSS 값을 읽지 못해 RSS 기록을 건너뜀"
  else
    # 정보성 기록이며 통과/실패 기준이 아니다. fresh 프로세스는 다 쓴 Buffer가 GC 전까지
    # 쌓여 fixture 크기와 무관한 상한까지 늘 수 있어 임계값 판정에 쓸 수 없다.
    # 본문 보유 여부는 storix-http.client.spec.ts의 회귀 테스트가 검증하고,
    # 수신 측 정지 시의 백프레셔는 같은 파일의 백프레셔 테스트가 검증한다.
    log "   demo-was RSS 증가량: $((rss_after - rss_before)) KiB(정보성 기록, 판정 기준 아님)"
  fi
else
  log "   경고: 컨테이너 런타임/컨테이너를 찾지 못해 RSS 기록을 건너뜀"
fi

log "4a) MIME type 변경"
mime_status=$(curl -s -o "$WORKDIR/mime-response.json" -w '%{http_code}' -X PATCH \
  "$BASE_URL/demo-api/documents/mime-type" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"path\":\"${FILE_PATH}\",\"mimeType\":\"application/pdf\"}")
require_status 200 "$mime_status" "PATCH /demo-api/documents/mime-type"
jq -e --arg p "$FILE_PATH" '.path == $p and .mimeType == "application/pdf"' "$WORKDIR/mime-response.json" > /dev/null \
  || fail "MIME type 변경 응답 불일치: $(cat "$WORKDIR/mime-response.json")"

log "5) 목록 확인"
list_body=$(curl -sf "$BASE_URL/demo-api/documents?path=${DIR_PATH}" -H 'X-Demo-User: alice')
echo "$list_body" | jq -e --arg p "$FILE_PATH" '.items[] | select(.path == $p)' > /dev/null \
  || fail "목록에 ${FILE_PATH}가 없음: $list_body"
echo "$list_body" | jq -e --arg p "$FILE_PATH" '.items[] | select(.path == $p and .mimeType == "application/pdf")' > /dev/null \
  || fail "목록에 갱신된 MIME type이 없음: $list_body"

log "6) 검색 확인"
search_body=$(curl -sf "$BASE_URL/demo-api/documents/search?path=/&name=big.bin" -H 'X-Demo-User: alice')
echo "$search_body" | jq -e --arg p "$FILE_PATH" '.items[] | select(.path == $p)' > /dev/null \
  || fail "검색 결과에 ${FILE_PATH}가 없음: $search_body"

log "7) 복사"
copy_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/demo-api/entries/copy" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"source\":\"${FILE_PATH}\",\"destination\":\"${COPY_PATH}\"}")
require_status 204 "$copy_status" "POST /demo-api/entries/copy"

log "8) 이동/이름변경"
move_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/demo-api/entries/move" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"source\":\"${COPY_PATH}\",\"destination\":\"${MOVED_PATH}\"}")
require_status 204 "$move_status" "POST /demo-api/entries/move"

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

if [[ "$public_url" == *"documents"* ]] || [[ "$public_url" == *"alice"* ]] || [[ "$public_url" == *"${MOVED_PATH}"* ]]; then
  fail "공개 URL이 내부 경로/사용자 정보를 노출함: $public_url"
fi

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

# 상한 초과로 본문 전송이 중간에 끊겨도 WAS가 살아 있어야 한다.
# Readable.toWeb 어댑터가 이 경로에서 프로세스를 종료시킨 적이 있다(request-body-stream.ts).
alive_status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/demo-api/documents?path=/" -H 'X-Demo-User: alice')
require_status 200 "$alive_status" "업로드 상한 초과 뒤 WAS 생존"

log "20) 재개 업로드(enable-resumable-upload.sh로 활성화한 스택에서만)"
new_uuid() { uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid; }
RESUMABLE_DIR="/resumable-${RUN_ID}"
RESUMABLE_PART_BYTES=16777216
RESUMABLE_BYTES=$((RESUMABLE_PART_BYTES + 1048576))
mkdir_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/demo-api/directories" \
  -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
  -d "{\"path\":\"${RESUMABLE_DIR}\"}")
require_status 204 "$mkdir_status" "POST /demo-api/directories(재개 업로드)"
head -c "$RESUMABLE_BYTES" /dev/urandom > "$WORKDIR/resumable.bin"
resumable_sha256=$(sha256sum "$WORKDIR/resumable.bin" | awk '{print $1}')
head -c "$RESUMABLE_PART_BYTES" "$WORKDIR/resumable.bin" > "$WORKDIR/part0.bin"
tail -c +"$((RESUMABLE_PART_BYTES + 1))" "$WORKDIR/resumable.bin" > "$WORKDIR/part1.bin"

create_status=$(curl -s -o "$WORKDIR/session.json" -w '%{http_code}' -X POST "$BASE_URL/demo-api/documents/upload-sessions" \
  -H 'X-Demo-User: alice' -H "Idempotency-Key: $(new_uuid)" -H 'Content-Type: application/json' \
  -d "{\"path\":\"${RESUMABLE_DIR}/resumed.bin\",\"sizeBytes\":\"${RESUMABLE_BYTES}\",\"mimeType\":\"application/octet-stream\",\"ifAbsent\":true,\"sha256\":\"${resumable_sha256}\"}")
if [ "$create_status" = "409" ] && jq -e '.code == "VFS_FEATURE_DISABLED"' "$WORKDIR/session.json" >/dev/null 2>&1; then
  log "   resumable-upload가 비활성이라 건너뜀(enable-resumable-upload.sh로 활성화)"
else
  require_status 201 "$create_status" "POST /demo-api/documents/upload-sessions"
  session_id=$(jq -r '.sessionId' "$WORKDIR/session.json")
  jq -e '.partSizeBytes == '"$RESUMABLE_PART_BYTES"' and .partCount == 2' "$WORKDIR/session.json" >/dev/null \
    || fail "세션 응답의 조각 크기·개수가 기대와 다름: $(cat "$WORKDIR/session.json")"
  session_url="$BASE_URL/demo-api/documents/upload-sessions/${session_id}"

  part1_status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$session_url/parts/1" \
    -H 'X-Demo-User: alice' -H 'Content-Type: application/octet-stream' --data-binary "@$WORKDIR/part1.bin")
  require_status 200 "$part1_status" "PUT 조각 1(순서 뒤집어 전송)"
  incomplete_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$session_url/complete" -H 'X-Demo-User: alice')
  require_status 409 "$incomplete_status" "조각 누락 상태의 완료"
  bob_status=$(curl -s -o /dev/null -w '%{http_code}' "$session_url" -H 'X-Demo-User: bob')
  require_status 404 "$bob_status" "다른 사용자의 세션 조회"

  # 재개: 서버에 저장된 조각 index만 확인하고 빠진 조각을 보낸다.
  curl -sf "$session_url" -H 'X-Demo-User: alice' | jq -e '[.parts[].index] == [1]' >/dev/null \
    || fail "세션 상태의 저장된 조각이 [1]이 아님"
  part0_status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$session_url/parts/0" \
    -H 'X-Demo-User: alice' -H 'Content-Type: application/octet-stream' --data-binary "@$WORKDIR/part0.bin")
  require_status 200 "$part0_status" "PUT 조각 0(재개)"
  complete_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$session_url/complete" -H 'X-Demo-User: alice')
  require_status 201 "$complete_status" "POST 완료"

  resumable_download=$(curl -sf -X POST "$BASE_URL/demo-api/documents/download" \
    -H 'X-Demo-User: alice' -H 'Content-Type: application/json' \
    -d "{\"path\":\"${RESUMABLE_DIR}/resumed.bin\"}" | jq -r '.url')
  curl -sf "$resumable_download" -o "$WORKDIR/resumed-downloaded.bin"
  [ "$(sha256sum "$WORKDIR/resumed-downloaded.bin" | awk '{print $1}')" = "$resumable_sha256" ] \
    || fail "재개 업로드 파일 SHA-256 불일치"
  closed_status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$session_url/parts/0" \
    -H 'X-Demo-User: alice' -H 'Content-Type: application/octet-stream' --data-binary "@$WORKDIR/part0.bin")
  require_status 409 "$closed_status" "완료된 세션에 조각 추가"
fi
curl -s -o /dev/null -X DELETE "$BASE_URL/demo-api/entries?path=${RESUMABLE_DIR}&recursive=true" -H 'X-Demo-User: alice'

log "전체 smoke test 통과"
