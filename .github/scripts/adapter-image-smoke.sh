#!/usr/bin/env bash
# 어댑터 변형 이미지 안에서 어댑터 로드와 X_REF 해석을 확인한다.
# 사용법: adapter-image-smoke.sh <이미지> <bao|aws>
# 종료 코드는 이미지 안 smoke.mjs의 종료 코드를 따른다. 출력에 시험 값(SMOKE-SENTINEL)이 있으면 실패한다.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf '사용법: %s <이미지> <bao|aws>\n' "$0" >&2
  exit 2
fi
readonly image="$1" adapter="$2"
case "$adapter" in
  bao | aws) ;;
  *)
    printf '알 수 없는 어댑터: %s\n' "$adapter" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly root
readonly package_dir="$root/packages/secret-source-$adapter"

mounts=(--volume "$package_dir/image-smoke/smoke.mjs:/smoke/smoke.mjs:ro")
if [[ "$adapter" == "bao" ]]; then
  mounts+=(--volume "$package_dir/test-support:/smoke/test-support:ro")
fi

output="$(docker run --rm --network none "${mounts[@]}" --entrypoint node "$image" /smoke/smoke.mjs 2>&1)" && status=0 || status=$?
printf '%s\n' "$output"
if grep -q 'SMOKE-SENTINEL' <<<"$output"; then
  printf '스모크 출력에 시험 값이 있다\n' >&2
  exit 1
fi
exit "$status"
