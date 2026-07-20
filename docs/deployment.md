# Deployment

## Docker Compose

Configure independent secrets before starting:

```bash
cp .env.example .env
sed -i.bak "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
sed -i.bak "s/^DEV_ADMIN_KEY=.*/DEV_ADMIN_KEY=$(openssl rand -hex 32)/" .env
rm -f .env.bak
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:8080/health
```

Open the dashboard at `http://127.0.0.1:8080/`, expand **Use dev admin key
instead**, paste `DEV_ADMIN_KEY`, and press **Enter**.

### Persistence and runtime identity

Compose mounts the `super-proxy-data` named volume at `/app/data` and sets:

```text
DATABASE_PATH=/app/data/super-proxy.sqlite
```

The image runs as uid/gid `10001:10001`. A new named volume inherits the
writable `/app/data` ownership from the image. If you replace the named volume
with a host bind mount, create the directory and grant uid/gid `10001:10001`
write access before starting the container.

Confirm the runtime contract:

```bash
docker compose exec super-proxy id
docker compose exec super-proxy sh -c \
  'test -w /app/data && test -f /app/data/super-proxy.sqlite'
```

### Healthcheck

The container healthcheck requests `/health`. The endpoint reports unhealthy
until database migrations are current.

```bash
docker compose ps
docker compose logs super-proxy
```

## Bare metal or systemd

```bash
npm ci
npm run build
NODE_ENV=production \
PORT=8080 \
DATABASE_PATH=/var/lib/super-proxy/super-proxy.sqlite \
npm start
```

Ensure the process environment also supplies `SESSION_SECRET` and the chosen
administrator authentication configuration. Run under an unprivileged service
account and terminate TLS at a reverse proxy such as Caddy, Nginx, or Traefik.

## Hardening checklist

1. Restrict the dashboard to a trusted network or authenticated access layer.
2. Use TLS for every non-local deployment.
3. Protect and rotate `SESSION_SECRET`, `DEV_ADMIN_KEY`, gateway tokens, and
   provider credentials.
4. Restrict outbound egress when required by policy.
5. Back up SQLite and test restore procedures.
6. Pin image digests in production deployments.
7. Monitor `/health` and container restarts.

## Upgrades

1. Read release notes and back up the database.
2. Pull the intended tagged version.
3. Rebuild the image or run `npm ci && npm run build`.
4. Restart the service; migrations run before the server starts.
5. Confirm `/health`, dashboard access, and a scoped provider request.

Use Git tags and GitHub Releases as the source of truth for published versions.
