# Getting started

## 1. Clone and configure

```bash
git clone https://github.com/Nextbasedev/super-proxy.git
cd super-proxy
cp .env.example .env
sed -i.bak "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
sed -i.bak "s/^DEV_ADMIN_KEY=.*/DEV_ADMIN_KEY=$(openssl rand -hex 32)/" .env
rm -f .env.bak
```

The values must be independent. Keep `.env` private: `SESSION_SECRET` signs
browser sessions, while `DEV_ADMIN_KEY` grants bootstrap administrator access.

## 2. Start the gateway

With Node.js 20+:

```bash
npm ci
npm run build
npm start
```

Or with Docker Compose:

```bash
docker compose up --build -d
```

Verify readiness:

```bash
curl -fsS http://127.0.0.1:8080/health
```

## 3. Bootstrap the dashboard

1. Visit `http://127.0.0.1:8080/`.
2. Expand **Use dev admin key instead**.
3. Paste the `DEV_ADMIN_KEY` value from `.env` and press **Enter**.
4. Open **Identity**, create a user, and issue that user an API token.
5. Copy the displayed token immediately. The raw token is shown only once.

The dev key uses the `x-admin-key` request header. It does not create a browser
session and should not be shared with regular users.

## 4. Send a test request

```bash
export SUPER_PROXY_URL=http://127.0.0.1:8080
export SUPER_PROXY_API_KEY=sp_your_token_here
bash examples/basic-chat.sh
```

Provider requests require a corresponding upstream account or credential.
Configure providers from the dashboard after bootstrap.

## Docker data

Compose persists the database in the `super-proxy-data` named volume, mounted
at `/app/data` for the unprivileged uid/gid `10001:10001` runtime user.

Stop the service without deleting data:

```bash
docker compose down
```

Delete the service and its data only when intentional:

```bash
docker compose down --volumes
```
