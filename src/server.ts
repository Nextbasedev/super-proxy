import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { registerHealthRoutes } from './admin/health.js';
import { registerAdminApi } from './admin/admin-api.js';
import { registerAnthropicProxy } from './proxy/anthropic.js';
import { registerOpenAiProxy } from './proxy/openai.js';
import { registerGroqProxy } from './proxy/groq.js';
import { registerCerebrasProxy } from './proxy/cerebras.js';
import { registerKimiProxy } from './proxy/kimi.js';
import { registerGlmProxy } from './proxy/glm.js';
import { registerGeminiProxy } from './proxy/gemini.js';
import { registerGeminiLiveRelay } from './proxy/gemini-live.js';
import { registerOpenRouterProxy } from './proxy/openrouter.js';
import { registerDeepgramProxy } from './proxy/deepgram.js';
import { registerFishProxy } from './proxy/fish.js';
import { registerXaiProxy } from './proxy/xai.js';
import { registerRunpodProxy } from './proxy/runpod.js';
import { registerSearchProxy } from './proxy/search.js';
import { registerFusionProxy } from './proxy/fusion.js';
import { registerCompressionMiddleware } from './proxy/compress.js';
import { registerDashboardAuthRoutes } from './auth/dashboard-auth.js';
import { registerSelfApi } from './self-api.js';
import { registerProviderModelsRoutes } from './api/provider-models.js';
import { startRollupLoop } from './monitoring/rollup.js';
import { registerMetricsApi } from './monitoring/metrics-api.js';
import { registerBrowserCors } from './http/cors.js';

async function main() {
  migrate();
  // Redact credentials from request logs. The Gemini Live WS relay accepts the
  // gateway token via query param (browsers can't set WS headers), so the raw URL
  // and Authorization header must never reach the log sink verbatim.
  const CRED_QUERY_KEYS = ['access_token', 'token', 'api_key', 'apikey', 'key', 'authorization'];
  const redactUrl = (url: string): string => {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return url;
    const base = url.slice(0, qIdx);
    const params = new URLSearchParams(url.slice(qIdx + 1));
    for (const k of CRED_QUERY_KEYS) if (params.has(k)) params.set(k, '[redacted]');
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const app = Fastify({
    bodyLimit: 50 * 1024 * 1024,
    logger: {
      serializers: {
        req(req: any) {
          return {
            method: req.method,
            url: redactUrl(String(req.url || '')),
            remoteAddress: req.ip,
          };
        },
      },
      redact: { paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'], censor: '[redacted]' },
    },
  });
  await registerBrowserCors(app);
  await app.register(cookie);
  // WebSocket support for the Gemini Live (realtime) relay. 8 MB max frame covers
  // chunked PCM audio turns; the relay forwards frames without buffering whole turns.
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  // Compute a stable build id (git SHA if available, otherwise startup timestamp).
  // Used to cache-bust dashboard assets through any CDN.
  const buildId = (() => {
    try {
      const sha = fs.readFileSync(path.join(process.cwd(), '.git', 'HEAD'), 'utf8').trim();
      const ref = sha.startsWith('ref: ') ? fs.readFileSync(path.join(process.cwd(), '.git', sha.slice(5)), 'utf8').trim() : sha;
      return ref.slice(0, 8);
    } catch {
      return crypto.randomBytes(4).toString('hex');
    }
  })();

  // Optional dashboard/static shell (wave-2 apps/console). Provider API routes
  // must still boot cleanly when public/ is absent from the OSS tree.
  const publicRoot = path.join(process.cwd(), 'public');
  const indexPath = path.join(publicRoot, 'index.html');
  if (fs.existsSync(publicRoot)) {
    const serveIndex = (_req: any, reply: any) => {
      try {
        const html = fs.readFileSync(indexPath, 'utf8')
          .replace(/\/console\.js(\?[^"']*)?/g, `/console.js?v=${buildId}`)
          .replace(/\/console\.css(\?[^"']*)?/g, `/console.css?v=${buildId}`);
        reply.header('cache-control', 'no-store, no-cache, must-revalidate');
        reply.type('text/html; charset=utf-8').send(html);
      } catch (err: any) {
        reply.code(500).send({ error: 'index.html missing', detail: String(err?.message || err) });
      }
    };
    app.get('/', serveIndex);
    app.get('/index.html', serveIndex);

    app.addHook('onSend', async (req, reply, payload) => {
      const urlPath = String(req.raw.url || '').split('?')[0];
      if (urlPath.endsWith('.md')) {
        reply.type('text/markdown; charset=utf-8');
        reply.header('Cache-Control', 'public, max-age=300');
      }
      return payload;
    });

    await app.register(fastifyStatic, {
      root: publicRoot,
      prefix: '/',
      index: false,
      setHeaders: (res, filePath) => {
        const base = path.basename(filePath);
        // console.js / console.css are versioned via ?v=<buildId>. Tell CDNs they
        // can cache aggressively per URL, and force revalidate when the version
        // changes.
        if (base === 'console.js' || base === 'console.css') {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        if (path.extname(filePath) === '.md') {
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.setHeader('Cache-Control', 'public, max-age=300');
        }
      },
    });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('application/json').send({
        ok: true,
        service: process.env.GATEWAY_NAME || 'super-proxy',
        docs: 'Provider routes are registered; dashboard static assets are not bundled in this build.',
      });
    });
  }

  registerHealthRoutes(app);
  registerDashboardAuthRoutes(app);
  registerSelfApi(app);
  registerProviderModelsRoutes(app);
  registerAdminApi(app);
  registerMetricsApi(app);
  registerAnthropicProxy(app);
  registerOpenAiProxy(app);
  registerGroqProxy(app);
  registerCerebrasProxy(app);
  registerKimiProxy(app);
  registerGlmProxy(app);
  registerGeminiProxy(app);
  registerGeminiLiveRelay(app);
  registerOpenRouterProxy(app);
  registerDeepgramProxy(app);
  registerFishProxy(app);
  registerXaiProxy(app);
  registerRunpodProxy(app);
  registerSearchProxy(app);
  registerFusionProxy(app);

  // Headroom context compression — must be registered AFTER all provider proxies
  // so the preHandler hook applies to all compressible routes.
  registerCompressionMiddleware(app);

  // Monitoring rollups + retention (docs/MONITORING-SYSTEM.md Phase 2).
  startRollupLoop(app.log as any);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
