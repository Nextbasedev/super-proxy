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
    PORT=4580 \
    DATABASE_PATH=/app/data/model-gateway.sqlite

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
COPY docs ./docs
COPY README.md ./.env.example ./

# Create a dedicated non-root user+group with a FIXED uid/gid (10001:10001) to
# match the thread-agent convention on this box. deploy-guard requires the
# container to run as non-root.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app

# Ensure the data dir (sqlite lives here) and app tree are owned by the runtime
# uid:gid so migrations/server can write the DB.
# NOTE (prod): the host bind mount at /app/data must ALSO be chown'd to
# 10001:10001 on the host, otherwise the container cannot write its sqlite DB.
# See docs/HARDENING.md.
RUN mkdir -p /app/data && chown -R 10001:10001 /app/data /app
VOLUME ["/app/data"]
EXPOSE 4580

USER 10001:10001

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
