# Headroom /v1/compress Adapter Spec

## Goal
Make Super Proxy's Headroom sidecar contract work when the sidecar runs in the main Docker Compose network.

## Problem
Super Proxy calls `HEADROOM_URL + /v1/compress` from the `super-proxy` container. In production the correct URL is `http://headroom-proxy:8899`, but Headroom 0.30.0 protects `/v1/compress` with loopback-only checks and returns 404 for Docker-network peers.

## Acceptance Criteria
- `headroom-proxy` exposes `POST /v1/compress` on port 8899 for Super Proxy.
- The adapter forwards requests to upstream Headroom on loopback inside the same container.
- Response contract remains `{ messages, tokens_before, tokens_saved, ... }`.
- Health endpoint verifies both adapter and upstream Headroom are healthy.
- Main compose remains private Docker-network sidecar with `HEADROOM_URL=http://headroom-proxy:8899`.
- Production can keep `HEADROOM_ENABLED=false` until explicitly enabled.

## Non-goals
- Do not expose the full Headroom proxy API to the Docker network.
- Do not vendor/fork Headroom internals.
- Do not enable production compression in this PR.
