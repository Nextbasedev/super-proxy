#!/usr/bin/env bash
set -euo pipefail
: "${SUPER_PROXY_URL:=http://127.0.0.1:8080}"
: "${SUPER_PROXY_API_KEY:?Set SUPER_PROXY_API_KEY to a gateway API token}"

curl -sS "$SUPER_PROXY_URL/v1/messages" \
  -H "x-api-key: $SUPER_PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"${MODEL:-claude-sonnet-4-5}"'",
    "max_tokens": 128,
    "messages": [{"role":"user","content":"Reply with a short hello."}]
  }'
echo
