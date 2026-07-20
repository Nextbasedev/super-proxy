FROM python:3.12-slim

# Build deps for hnswlib (C++ extension compiled from source)
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl \
    && pip install --no-cache-dir "headroom-ai[proxy]==0.30.0" \
    && apt-get purge -y build-essential && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY compress_adapter.py /app/compress_adapter.py
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
WORKDIR /app

ENV HEADROOM_TELEMETRY=off \
    HEADROOM_INTERNAL_URL=http://127.0.0.1:8898

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD curl -fsS http://127.0.0.1:8899/health || exit 1

CMD ["/app/start.sh"]
