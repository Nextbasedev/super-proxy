import type { FastifyInstance } from 'fastify';
import { requireProxyToken, authContextFromToken } from '../auth/token-auth.js';
import { selectAccount, markCooldown, markDead } from '../providers/governor.js';
import { recordUsage } from './usage.js';
import { logRequestResponse, shouldLogBody } from './policy.js';

const DEFAULTS: Record<string, string> = {
  gemini: 'gemini-2.5-flash-lite',
  xai: 'grok-4.3',
  codex: 'gpt-5.4-mini',
};

type SearchProvider = 'gemini' | 'xai' | 'codex';

function clampLimit(value: any): number {
  const n = Number(value ?? 10);
  return Math.max(1, Math.min(20, Number.isFinite(n) ? Math.floor(n) : 10));
}

function authHeaders(headers: any): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' };
  for (const k of ['authorization', 'x-api-key', 'api-key', 'apikey']) {
    const v = headers?.[k];
    if (Array.isArray(v) && v[0]) out[k] = String(v[0]);
    else if (v) out[k] = String(v);
  }
  return out;
}

function uniqueResults(items: Array<{ title?: string; url?: string; snippet?: string; source?: string }>, limit: number) {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const item of items) {
    const url = item.url || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ index: out.length + 1, title: item.title || url, url, ...(item.snippet ? { snippet: item.snippet } : {}), ...(item.source ? { source: item.source } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

function urlsFromText(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s"<>\\)\]]+/g)].map((m) => ({ url: m[0].replace(/[.,;:]+$/, ''), title: m[0].replace(/[.,;:]+$/, '') }));
}

function parseResponsesSse(body: string) {
  const chunks: string[] = [];
  const results: any[] = [];
  let usage: any = undefined;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === 'response.output_text.delta') chunks.push(evt.delta || '');
      if (evt.type === 'response.output_text.annotation.added' && evt.annotation?.url) {
        results.push({ title: evt.annotation.title || evt.annotation.url, url: evt.annotation.url, source: 'annotation' });
      }
      const resp = evt.response;
      if (resp?.usage) usage = resp.usage;
      const output = resp?.output || [];
      for (const item of output) {
        for (const part of item.content || []) {
          for (const ann of part.annotations || []) if (ann.url) results.push({ title: ann.title || ann.url, url: ann.url, source: 'annotation' });
        }
      }
    } catch {}
  }
  const answer = chunks.join('');
  return { answer, results: results.length ? results : urlsFromText(answer), usage };
}

function parseGemini(body: string, limit: number) {
  const parsed = JSON.parse(body);
  const msg = parsed?.choices?.[0]?.message || {};
  const content = String(msg.content || '');
  const answer = content.split(/\n\nSources:\n/)[0];
  const ann = Array.isArray(msg.annotations) ? msg.annotations : [];
  const fromAnnotations = ann.map((a: any) => ({ title: a.title, url: a.url, source: 'grounding' }));
  return { answer, results: uniqueResults(fromAnnotations.length ? fromAnnotations : urlsFromText(content), limit), usage: parsed.usage, raw: { grounding_metadata: parsed.grounding_metadata } };
}

function parseJsonOrSse(body: string, limit: number) {
  if (body.trim().startsWith('{')) {
    const parsed = JSON.parse(body);
    const msg = parsed?.choices?.[0]?.message?.content || parsed?.output_text || JSON.stringify(parsed);
    return { answer: String(msg), results: uniqueResults(urlsFromText(String(msg)), limit), usage: parsed.usage };
  }
  const out = parseResponsesSse(body);
  return { ...out, results: uniqueResults(out.results, limit) };
}

function domain(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return undefined; }
}

function normalizeSerperResults(parsed: any, limit: number) {
  const organic = Array.isArray(parsed?.organic) ? parsed.organic : [];
  return organic.slice(0, limit).map((r: any, idx: number) => {
    const url = String(r.link || r.url || '');
    return {
      index: Number(r.position || idx + 1),
      title: String(r.title || url || `Result ${idx + 1}`),
      url,
      display_url: r.displayedLink || r.displayLink || domain(url),
      snippet: r.snippet || undefined,
      source: 'google_serp',
    };
  }).filter((r: any) => r.url);
}

function stringParam(body: any, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = body?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function serperPayload(body: any, query: string, limit: number) {
  const payload: any = { q: query, num: limit };
  const gl = stringParam(body, 'gl', 'country');
  const hl = stringParam(body, 'hl', 'language');
  const tbs = stringParam(body, 'tbs', 'dateRange', 'date_range');
  if (gl) payload.gl = gl.toLowerCase();
  if (hl) payload.hl = hl.toLowerCase();
  if (tbs) payload.tbs = tbs;
  if (typeof body.location === 'string' && body.location.trim()) payload.location = body.location.trim();
  if (typeof body.page === 'number' && Number.isFinite(body.page) && body.page > 0) payload.page = Math.floor(body.page);
  if (typeof body.autocorrect === 'boolean') payload.autocorrect = body.autocorrect;
  return payload;
}

async function handleSerpSearch(req: any, reply: any, auth: any, body: any, query: string, limit: number) {
  const selected = selectAccount('serper', `${auth.user.id}:${query}`);
  if (!selected) {
    reply.code(503).send({ error: { type: 'service_unavailable', message: 'No available Serper accounts' } });
    return;
  }
  const { account, release } = selected;
  const started = Date.now();
  const payload = serperPayload(body, query, limit);
  let statusCode = 502;
  let responseText = '';
  let usageEventId = 0;
  try {
    const upstream = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': account.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    statusCode = upstream.status;
    responseText = await upstream.text();
    const remaining = upstream.headers.get('x-ratelimit-remaining');
    const reset = upstream.headers.get('x-ratelimit-reset');
    if (statusCode === 429) {
      const resetMs = reset && /^\d+$/.test(reset) ? Math.max(60_000, Number(reset) * 1000 - Date.now()) : 60 * 60_000;
      markCooldown(account.id, resetMs, 'serper_rate_limit');
    } else if (statusCode === 401 || statusCode === 403) {
      markDead(account.id, `serper_auth_${statusCode}`);
    }

    usageEventId = recordUsage({
      userId: auth.user.id,
      tokenId: auth.token.id,
      providerAccountId: account.id,
      provider: 'serper',
      endpoint: '/v1/search',
      model: 'google-serp',
      stream: false,
      statusCode,
      inputTokens: 1,
      outputTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: Date.now() - started,
      error: statusCode >= 400 ? responseText.slice(0, 500) : undefined,
      tokenLabel: auth.token.label,
      providerAccountLabel: account.label,
    });
    release();

    if (shouldLogBody(auth.user)) {
      logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: payload, responseText });
    }

    if (statusCode >= 400) {
      reply.code(statusCode).type('application/json').send(responseText || JSON.stringify({ error: { type: 'serper_error', message: 'Serper request failed' } }));
      return;
    }

    const parsed = JSON.parse(responseText || '{}');
    const results = normalizeSerperResults(parsed, limit);
    reply.header('x-gateway-provider', 'serper');
    reply.header('x-gateway-account', account.label);
    reply.send({
      query,
      mode: 'serp',
      provider: 'serper',
      source: 'google_serp',
      fetched_at: new Date().toISOString(),
      cache_status: 'none',
      results,
      answer: null,
      usage: {
        credits: parsed.credits,
        rate_limit_remaining: remaining != null ? Number(remaining) : undefined,
        rate_limit_reset: reset != null ? Number(reset) : undefined,
      },
      search_parameters: parsed.searchParameters,
      knowledge_graph: parsed.knowledgeGraph,
      related_searches: parsed.relatedSearches,
    });
  } catch (err: any) {
    release();
    const message = err?.message || String(err);
    usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'serper', endpoint: '/v1/search', model: 'google-serp', stream: false, statusCode: 502, inputTokens: 1, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: message, tokenLabel: auth.token.label, providerAccountLabel: account.label });
    reply.code(502).send({ error: { type: 'upstream_error', message } });
  }
}

// SearXNG-compatible adapter: lets SearXNG-compatible `web_search` clients
// (`searxng`, the only one accepting an arbitrary base URL with no API key)
// route through NBMG to our real Serper Google SERP, fully metered.
//
// Contract (from the SearXNG client contract):
//  - GET, path must end in `/search` (client blindly appends it to baseUrl).
//  - Auth must live in the URL PATH (`:token`), because the client wipes the
//    query string of the configured baseUrl and sends no Authorization header.
//  - Params it sets: q, format=json, optional categories/language.
//  - Response must be SearXNG-shaped: top-level `results[]` with string
//    `url` + `title`; snippet field MUST be named `content` (we remap it).
//  - On failure return a NON-200 with a short body (never 200 + error).
async function handleSearxngAdapter(req: any, reply: any) {
  const token = String((req.params as any)?.token || '').trim();
  const auth = authContextFromToken(token);
  if (!auth) {
    reply.code(401).type('text/plain').send('Invalid or disabled search token');
    return;
  }
  const q = req.query as any;
  const query = typeof q?.q === 'string' ? q.q.trim() : '';
  if (!query) {
    reply.code(400).type('text/plain').send('Missing required query parameter: q');
    return;
  }
  // SearXNG client trims to its own count (default 5 / max 10); cap at 10.
  const limit = Math.min(10, clampLimit(q?.count ?? q?.limit ?? 10));
  // Optional language passthrough → Serper hl.
  const body: any = {};
  if (typeof q?.language === 'string' && q.language.trim()) body.hl = q.language.trim();

  const selected = selectAccount('serper', `${auth.user.id}:${query}`);
  if (!selected) {
    reply.code(503).type('text/plain').send('No available Serper accounts');
    return;
  }
  const { account, release } = selected;
  const started = Date.now();
  const payload = serperPayload(body, query, limit);
  let statusCode = 502;
  let responseText = '';
  let usageEventId = 0;
  try {
    const upstream = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': account.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    statusCode = upstream.status;
    responseText = await upstream.text();
    const reset = upstream.headers.get('x-ratelimit-reset');
    if (statusCode === 429) {
      const resetMs = reset && /^\d+$/.test(reset) ? Math.max(60_000, Number(reset) * 1000 - Date.now()) : 60 * 60_000;
      markCooldown(account.id, resetMs, 'serper_rate_limit');
    } else if (statusCode === 401 || statusCode === 403) {
      markDead(account.id, `serper_auth_${statusCode}`);
    }
    usageEventId = recordUsage({
      userId: auth.user.id,
      tokenId: auth.token.id,
      providerAccountId: account.id,
      provider: 'serper',
      endpoint: '/v1/searxng',
      model: 'google-serp',
      stream: false,
      statusCode,
      inputTokens: 1,
      outputTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: Date.now() - started,
      error: statusCode >= 400 ? responseText.slice(0, 500) : undefined,
      tokenLabel: auth.token.label,
      providerAccountLabel: account.label,
    });
    release();
    if (shouldLogBody(auth.user)) {
      logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: payload, responseText });
    }
    if (statusCode >= 400) {
      reply.code(statusCode).type('text/plain').send(`Serper request failed (${statusCode})`);
      return;
    }
    const parsed = JSON.parse(responseText || '{}');
    const norm = normalizeSerperResults(parsed, limit);
    // Remap to SearXNG shape: snippet -> content (the field SearXNG clients read).
    const results = norm.map((r: any) => ({
      url: r.url,
      title: r.title,
      content: r.snippet || '',
      engine: 'google',
      category: 'general',
    }));
    reply.header('x-gateway-provider', 'serper');
    reply.header('x-gateway-account', account.label);
    reply.type('application/json').send({
      query,
      number_of_results: results.length,
      results,
    });
  } catch (err: any) {
    release();
    const message = err?.message || String(err);
    recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'serper', endpoint: '/v1/searxng', model: 'google-serp', stream: false, statusCode: 502, inputTokens: 1, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: message, tokenLabel: auth.token.label, providerAccountLabel: account.label });
    reply.code(502).type('text/plain').send(`Upstream error: ${message}`);
  }
}

export function registerSearchProxy(app: FastifyInstance) {
  // SearXNG-compatible adapter route (token in path; path ends in /search).
  app.get('/v1/searxng/:token/search', handleSearxngAdapter);

  app.post('/v1/search', async (req, reply) => {
    const auth = await requireProxyToken(req, reply);
    if (!auth) return;
    const body = (req.body as any) || {};
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) { reply.code(400).send({ error: { type: 'invalid_request_error', message: 'query is required' } }); return; }
    const mode = body.mode || 'models';
    const limit = clampLimit(body.limit);
    if (mode === 'serp') {
      await handleSerpSearch(req, reply, auth, body, query, limit);
      return;
    }
    if (mode !== 'models') {
      reply.code(400).send({ error: { type: 'invalid_request_error', message: `mode must be one of: models, serp` } });
      return;
    }
    const provider = (body.provider || 'gemini') as SearchProvider;
    if (!['gemini', 'xai', 'codex'].includes(provider)) {
      reply.code(400).send({ error: { type: 'invalid_request_error', message: 'provider must be one of: gemini, xai, codex' } });
      return;
    }
    const model = typeof body.model === 'string' && body.model ? body.model : DEFAULTS[provider];
    const prompt = `Search the web for: ${query}\n\nReturn a concise answer and use source links. Prefer ${limit} useful sources/results.`;

    let injected: any;
    if (provider === 'gemini') {
      injected = await app.inject({ method: 'POST', url: '/v1/gemini/chat/completions', headers: authHeaders(req.headers), payload: { model, messages: [{ role: 'user', content: prompt }], tools: [{ type: 'web_search' }], max_tokens: body.max_tokens || 768 } });
    } else if (provider === 'xai') {
      injected = await app.inject({ method: 'POST', url: '/v1/xai/responses', headers: authHeaders(req.headers), payload: { model, input: [{ role: 'user', content: prompt }], tools: [{ type: 'web_search' }], stream: true, max_output_tokens: body.max_output_tokens || 768 } });
    } else {
      injected = await app.inject({ method: 'POST', url: '/v1/responses', headers: authHeaders(req.headers), payload: { model, input: prompt, tools: [{ type: 'web_search' }], tool_choice: 'auto', stream: true, max_output_tokens: body.max_output_tokens || 768 } });
    }

    if (injected.statusCode >= 400) {
      reply.code(injected.statusCode).type(injected.headers['content-type'] as string || 'application/json').send(injected.body);
      return;
    }

    const parsed: any = provider === 'gemini' ? parseGemini(injected.body, limit) : parseJsonOrSse(injected.body, limit);
    reply.send({ query, mode: 'models', provider, model, answer: parsed.answer, results: parsed.results, usage: parsed.usage, ...(parsed.raw || {}) });
  });
}
