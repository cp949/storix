#!/bin/sh
set -eu

: "${STORIX_LOCALSTACK_API_KEY:?테스트 Secret 값이 필요하다}"
: "${STORIX_LOCALSTACK_PREVIOUS_API_KEY:?테스트 Secret 값이 필요하다}"

endpoint="${LOCALSTACK_ENDPOINT:-http://localstack:4566}"

# 평문 Secret: 키 없는 참조(aws-sm://<SecretId>)를 확인한다.
aws --endpoint-url "$endpoint" \
  secretsmanager create-secret \
  --name storix/localstack/api-key \
  --secret-string "$STORIX_LOCALSTACK_API_KEY" \
  --region us-east-1 >/dev/null

# JSON Secret: 키 선택 참조(aws-sm://<SecretId>#<키>)를 확인한다. 값은 영숫자와 -만 있어 이스케이프가 필요 없다.
# unrelated는 문자열이 아닌 값이 섞여 있어도 다른 키 선택에 영향이 없는지 보는 용도다.
aws --endpoint-url "$endpoint" \
  secretsmanager create-secret \
  --name storix/localstack/bundle \
  --secret-string "{\"previous-api-key\":\"$STORIX_LOCALSTACK_PREVIOUS_API_KEY\",\"unrelated\":3}" \
  --region us-east-1 >/dev/null
