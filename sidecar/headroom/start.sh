#!/bin/sh
set -eu

headroom proxy \
  --host 127.0.0.1 \
  --port 8898 \
  --log-file /var/log/headroom/proxy.jsonl &
HEADROOM_PID="$!"

uvicorn compress_adapter:app --host 0.0.0.0 --port 8899 &
ADAPTER_PID="$!"

term() {
  kill "$ADAPTER_PID" "$HEADROOM_PID" 2>/dev/null || true
  wait "$ADAPTER_PID" 2>/dev/null || true
  wait "$HEADROOM_PID" 2>/dev/null || true
}
trap term INT TERM

# If either process exits, stop the other and exit non-zero.
while :; do
  if ! kill -0 "$HEADROOM_PID" 2>/dev/null; then
    term
    exit 1
  fi
  if ! kill -0 "$ADAPTER_PID" 2>/dev/null; then
    term
    exit 1
  fi
  sleep 1
done
