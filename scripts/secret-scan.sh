#!/usr/bin/env bash
# Fail if likely secrets or private markers are present in shippable paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Only scan runtime/product surfaces (not policy docs that name forbidden strings).
paths=(
  src
  public
  package.json
  docker-compose.yml
  Dockerfile
  .env.example
)

patterns=(
  'ghp_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'xai-[A-Za-z0-9]{20,}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----'
  'ampere-5b695'
  'infinitycorp\.tech'
  'daxitm2112@'
  'daxitm432@'
  'Daxitdon/'
  'openclaw-internal'
  '65\.21\.[0-9]+\.[0-9]+'
  'nextbase-model-gateway'
  'registerAside'
  'registerOcFleet'
  '/api/internal/oc/aside/'
  'aside_gateways'
)

exclude=(
  --glob '!**/*.test.ts'
  --glob '!**/node_modules/**'
  --glob '!**/dist/**'
)

fail=0
for pat in "${patterns[@]}"; do
  if rg -n -I -e "$pat" "${exclude[@]}" "${paths[@]}" >/tmp/super-proxy-secret-scan.out 2>/dev/null; then
    echo "secret-scan HIT for pattern: $pat" >&2
    head -n 50 /tmp/super-proxy-secret-scan.out >&2 || true
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "secret-scan: FAILED" >&2
  exit 1
fi

echo "secret-scan: clean"
