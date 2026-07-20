# Headroom /v1/compress Adapter Loop

- Owner: Jarvis
- Repo: `/root/.openclaw/workspace/projects/model-gateway`
- Branch: `fix/headroom-compress-adapter`
- Worktree: `/root/.openclaw/workspace/projects/model-gateway-worktrees/headroom-compress-adapter`
- Evidence dir: `reports/coding-loops/headroom-compress-adapter/`

## Gates
- Sidecar Docker build succeeds.
- Sidecar `/health` returns healthy.
- Sidecar `/v1/compress` returns 200 with NBMG contract from non-loopback caller path.
- Existing NBMG tests/typecheck run or blockers recorded.

## Timeline
- 2026-07-08: Confirmed prod sidecar should run in main compose network; Headroom `/v1/compress` 404s due loopback guard from Docker DNS peer.
- 2026-07-08: Started adapter implementation.
- 2026-07-08: Implemented adapter that exposes `/v1/compress` on :8899 and forwards to Headroom loopback :8898 with loopback Host header.
- 2026-07-08: Docker smoke passed: `/health` healthy, `/v1/compress` returned 200 and saved 7,480 tokens on synthetic JSON tool output.
- 2026-07-08: `npm test` passed 375/375; `tsc` had no new errors beyond pre-existing websocket module typings.
