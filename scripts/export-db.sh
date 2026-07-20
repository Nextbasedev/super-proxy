#!/usr/bin/env bash
set -euo pipefail
DB_PATH="${DATABASE_PATH:-./data/model-gateway.sqlite}"
OUT="${1:-./data/model-gateway-export-$(date +%Y%m%d-%H%M%S).sqlite}"
mkdir -p "$(dirname "$OUT")"
cp "$DB_PATH" "$OUT"
echo "Exported $DB_PATH -> $OUT"
