# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/app/data/super-proxy.sqlite

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
COPY docs ./docs
COPY README.md LICENSE NOTICE .env.example ./

# Keep the runtime unprivileged and give its fixed uid/gid ownership of the
# persistent SQLite directory. A fresh named volume inherits this ownership.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app/data \
    && chown 10001:10001 /app/data

VOLUME ["/app/data"]
EXPOSE 8080
USER 10001:10001

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
