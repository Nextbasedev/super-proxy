# Container Hardening (non-root) — deploy-guard prerequisite

The model-gateway container now runs as a **non-root** user (`uid:gid = 10001:10001`)
with a hardened `docker-compose.yml`. This is a prerequisite for the deploy-guard
cutover.

## What changed

### `Dockerfile` (runtime stage)
- Creates a dedicated `app` user/group with **fixed** `uid:gid = 10001:10001`
  (matches the thread-agent convention on this box).
- `chown -R 10001:10001 /app/data /app` at build so the app tree and sqlite data
  dir are writable by the runtime user.
- `USER 10001:10001` before `CMD` — the process no longer runs as root.
- Everything else unchanged: multi-stage build, `EXPOSE 4580`, and the
  `node dist/db/migrate.js && node dist/server.js` command.

### `docker-compose.yml`
- `user: "10001:10001"` — explicit non-root at runtime.
- `security_opt: ["no-new-privileges:true"]` — process cannot gain privileges.
- `cap_drop: ["ALL"]` — drops all Linux capabilities (app only needs to bind a
  high port and read/write files, no caps required).
- `pids_limit: 512` — cheap fork-bomb guard.
- `read_only` rootfs is **intentionally NOT enabled** (sqlite writes under
  `/app/data`, which is a writable bind mount). It can be added later with a
  `/tmp` tmpfs after verifying all write paths — see the comment in the compose
  file.
- **Absolute prod paths** (so deploy-guard's release-dir model works regardless
  of the compose working directory):
  - `env_file: /opt/services/model-gateway/.env`
  - `volumes: /opt/services/model-gateway/data:/app/data`

## PROD PREREQUISITES (one-time, run by Don at/before deploy)

Because the container now runs as `10001:10001` and the compose file uses
absolute paths, the host must be prepared **once**:

1. **Chown the data dir** so the non-root container can write its sqlite DB:

   ```bash
   sudo chown -R 10001:10001 /opt/services/model-gateway/data
   ```

2. **Ensure `.env` exists at the absolute path** the compose file references:

   ```bash
   test -f /opt/services/model-gateway/.env && echo "OK: .env present" || echo "MISSING: place .env here"
   ```

> ⚠️ **First-deploy warning:** If this PR ships through the OLD pipeline before
> the chown is done, the freshly non-root container will fail to write
> `/app/data/model-gateway.sqlite` and the migrate/boot step will error. This is
> **rollback-safe** (no data is destroyed — the existing DB file is just not
> writable by the new uid until chown'd). Run the `chown` above, then restart the
> service.

## Verification (done locally in the PR)

- `npm ci && npm run build` (tsc) — pass.
- `docker build` — pass.
- Container runs as `uid=10001`, writes the sqlite DB under `/app/data`, and
  `/health` returns HTTP 200. See the PR description for pasted output.
