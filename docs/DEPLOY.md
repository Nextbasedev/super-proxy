# Deploy — Super Proxy

This repo is built on the Daxit 4GB server as a dev machine. Production should run on a separate server.

## Server setup

```bash
git clone <repo> /opt/super-proxy
cd /opt/super-proxy
npm ci
npm run build
cp .env.example .env
# edit .env: PORT, DATABASE_PATH, ADMIN_EMAIL, Firebase config, optional Discord webhook
npm run db:migrate
```

## systemd

```ini
[Unit]
Description=Super Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/super-proxy
EnvironmentFile=/opt/super-proxy/.env
ExecStart=/usr/bin/node /opt/super-proxy/dist/server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

## Import current key-dispenser keys once

```bash
DATABASE_PATH=/opt/super-proxy/data/super-proxy.sqlite npm exec tsx scripts/import-key-dispenser.ts /path/to/key-dispenser/keys.json
```

## API client config

Anthropic-compatible clients:

```bash
ANTHROPIC_BASE_URL=https://gateway-domain.example
ANTHROPIC_API_KEY=sp_xxx
```

OpenAI-compatible clients:

```bash
OPENAI_BASE_URL=https://gateway-domain.example/v1
OPENAI_API_KEY=sp_xxx
```


## GitHub-based deploy

Source of truth should be a private GitHub repo. The production server should pull from GitHub, not receive rsync copies from the dev machine.

Recommended flow:

```bash
# on dev machine
git remote add origin git@github.com:<org>/super-proxy.git
git branch -M main
git push -u origin main

# on production server
git clone git@github.com:<org>/super-proxy.git /opt/super-proxy
cd /opt/super-proxy
npm ci
npm run build
npm run db:migrate
```

For updates:

```bash
cd /opt/super-proxy
git pull --ff-only
npm ci
npm run build
npm run db:migrate
systemctl restart super-proxy
```

Keep `.env`, SQLite data, and secrets only on the production server.


## Public hostname

Production hostname:

```text
localhost:8080
```

Route this through the existing Cloudflare Tunnel on `your-server` to:

```text
http://127.0.0.1:4580
```

## Headroom compression sidecar

The Headroom sidecar auto-starts alongside the gateway via docker-compose.
It compresses LLM input tokens by 50-74% with zero accuracy loss.

### How it works

The `headroom-proxy` service is defined in `docker-compose.yml`.
When you run `docker compose up`, both the gateway and sidecar start together.
No separate setup needed.

### Enable compression

Add to the Super Proxy `.env` file:

```bash
HEADROOM_ENABLED=true
HEADROOM_URL=http://headroom-proxy:8899
# HEADROOM_TIMEOUT_MS=5000              # optional, default 5s
# HEADROOM_SKIP_PROVIDERS=xai           # optional, comma-separated
```

Restart: `docker compose up -d`

### Verify

```bash
docker compose ps                          # both containers healthy
docker exec headroom-proxy curl -s http://127.0.0.1:8899/health
docker exec headroom-proxy curl -s http://127.0.0.1:8899/stats
```

### Disable / Rollback

Set `HEADROOM_ENABLED=false` in `.env` and restart.
All requests pass through uncompressed. The sidecar stays running but idle.
