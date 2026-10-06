#!/bin/sh
set -eu

: "${STORIX_LOCALSTACK_API_KEY:?테스트 Secret 값이 필요하다}"

aws --endpoint-url "${LOCALSTACK_ENDPOINT:-http://localstack:4566}" \
  secretsmanager create-secret \
  --name storix/localstack/api-key \
  --secret-string "$STORIX_LOCALSTACK_API_KEY" \
  --region us-east-1 >/dev/null
