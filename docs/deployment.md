# Deployment

## Docker Compose (recommended)

```bash
cp .env.example .env
docker compose up --build -d
curl -fsS http://127.0.0.1:8080/health
```

Open the dashboard at `http://127.0.0.1:8080/`.

### Persistence

Compose mounts volume `super-proxy-data` to `/data` and sets:

```text
DATABASE_PATH=/data/super-proxy.sqlite
```

### Healthcheck

The container healthcheck hits `/health`.

## Bare metal / systemd

```bash
npm ci
npm run build
NODE_ENV=production PORT=8080 DATABASE_PATH=/var/lib/super-proxy/db.sqlite npm start
```

Run under your process manager. Terminate TLS at Caddy/Nginx/Traefik.

## Hardening checklist

1. Do not expose admin/dashboard to the open internet without auth edge controls  
2. Use strong API tokens; revoke unused tokens  
3. Keep provider credentials in env/secret manager  
4. Restrict outbound egress if required by policy  
5. Back up SQLite and test restore  
6. Pin image digests in production if you publish one  

## Upgrades

1. Pull new version  
2. `npm ci && npm run build` (or rebuild image)  
3. Restart process/container  
4. Confirm `/health` and migration id  

Migrations run on startup via `src/db/migrate.ts`.
