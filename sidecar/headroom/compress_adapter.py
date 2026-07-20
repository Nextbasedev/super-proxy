"""NBMG compatibility adapter for Headroom's loopback-only /v1/compress.

Headroom 0.30.0 exposes POST /v1/compress, but protects it with a
loopback-only guard. In production NBMG and the sidecar run as separate
containers on a private Docker network, so NBMG reaches the sidecar as
http://headroom-proxy:8899 and Headroom returns 404.

This adapter exposes only the narrow NBMG contract on :8899 and forwards it to
the real Headroom proxy bound to 127.0.0.1:8898 inside the same container.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

UPSTREAM = os.environ.get("HEADROOM_INTERNAL_URL", "http://127.0.0.1:8898")
TIMEOUT_SECONDS = float(os.environ.get("HEADROOM_ADAPTER_TIMEOUT_SECONDS", "30"))

logger = logging.getLogger("nbmg_headroom_adapter")

app = FastAPI(title="NBMG Headroom Compress Adapter", version="1.0.0")


async def _upstream_health() -> tuple[bool, dict[str, Any] | str]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{UPSTREAM}/health", headers={"Host": "127.0.0.1:8898"})
        text = resp.text
        try:
            body: dict[str, Any] | str = resp.json()
        except Exception:
            body = text[:500]
        return resp.status_code == 200, body
    except Exception as exc:
        return False, str(exc)


@app.get("/health")
@app.get("/readyz")
async def health() -> JSONResponse:
    ok, upstream = await _upstream_health()
    return JSONResponse(
        status_code=200 if ok else 503,
        content={
            "service": "nbmg-headroom-adapter",
            "status": "healthy" if ok else "unhealthy",
            "upstream_url": UPSTREAM,
            "upstream": upstream,
        },
    )


@app.post("/v1/compress")
async def compress(request: Request) -> Response:
    # Forward the body unchanged. The Host header is intentional: Headroom's
    # loopback guard checks both peer IP and Host, and both are loopback for this
    # in-container hop.
    body = await request.body()
    content_type = request.headers.get("content-type", "application/json")
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{UPSTREAM}/v1/compress",
                content=body,
                headers={
                    "Content-Type": content_type,
                    "Accept": request.headers.get("accept", "application/json"),
                    "Host": "127.0.0.1:8898",
                },
            )
    except httpx.TimeoutException:
        return JSONResponse(status_code=504, content={"error": "headroom compress upstream timed out"})
    except Exception:
        logger.exception("headroom compress upstream failed")
        return JSONResponse(status_code=502, content={"error": "headroom compress upstream failed"})

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )
