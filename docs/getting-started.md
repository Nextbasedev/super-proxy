# Getting started

## 1. Install

```bash
cp .env.example .env
npm ci
npm run build
```

## 2. Start

```bash
npm start
# -> http://127.0.0.1:8080
```

## 3. Open dashboard

Visit `http://127.0.0.1:8080/` and complete local admin/bootstrap flow for your environment.

## 4. Create an API token

Use the dashboard or admin API to create a token. Export it:

```bash
export SUPER_PROXY_API_KEY=sp_...
export SUPER_PROXY_URL=http://127.0.0.1:8080
```

## 5. Send a test chat

```bash
bash examples/basic-chat.sh
```

## Docker

```bash
docker compose up --build -d
```

Data persists in the `super-proxy-data` volume (see `docker-compose.yml`).
