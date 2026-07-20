#!/usr/bin/env bash
set -euo pipefail
: "${SUPER_PROXY_URL:=http://127.0.0.1:8080}"
: "${SUPER_PROXY_API_KEY:?Set SUPER_PROXY_API_KEY to a gateway API token}"

curl -sS "$SUPER_PROXY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $SUPER_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"${MODEL:-gpt-4o-mini}"'",
    "messages": [{"role":"user","content":"Reply with a short hello."}],
    "stream": false
  }'
echo
