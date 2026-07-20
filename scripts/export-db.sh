#!/usr/bin/env bash
set -euo pipefail
DB_PATH="${DATABASE_PATH:-./data/super-proxy.sqlite}"
OUT="${1:-./data/super-proxy-export-$(date +%Y%m%d-%H%M%S).sqlite}"
mkdir -p "$(dirname "$OUT")"
cp "$DB_PATH" "$OUT"
echo "Exported $DB_PATH -> $OUT"
