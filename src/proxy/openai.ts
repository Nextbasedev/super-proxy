import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { requireProxyToken } from '../auth/token-auth.js';
import { classifyProviderError, markCooldown, markDead, selectAccount } from '../providers/governor.js';
import { recordUsage } from './usage.js';
import { compressionFields } from './compress.js';
import { checkLooseLimit, enforceAfterUsage, isModelAllowedForUser, logRequestResponse, shouldLogBody } from './policy.js';
import { estimateCost } from './cost.js';
import {
  acquireCodexSlot,
  classifyCodexUpstreamError,
  ensureFreshCodexAccount,
  markCodexBucketRateLimited,
  markCodexInvalid,
  markCodexSuccess,
  markCodexTemporaryFailure,
  releaseCodexSlot,
  selectStickyCodexAccounts,
} from '../providers/codex-pool.js';
import { catalogModelIdsWithCapability } from '../providers/model-catalog.js';

function openAiError(message: string, type = 'server_error', code?: string) {
  return { error: { message, type, code: code || null } };
}

const OPENAI_REALTIME_DEFAULT_MODEL = 'gpt-realtime-2';

// gpt-5.6-luna resolves to a missing internal engine on the ChatGPT Codex
// backend for the `pi` originator cohort (openai/codex#31967). The backend
// routes model slugs per originator+version, and only the official CLI
// identity (`codex_cli_rs` + a version header) resolves Luna correctly.
// Verified against a live ChatGPT OAuth account (2026-07-11): pi/none,
// pi/0.144.1 and codex_cli_rs/none all fail; codex_cli_rs/0.144.1 succeeds.
// Scope the identity override to Luna only so the rest of Codex traffic
// keeps its existing cohort/routing behavior.
const CODEX_CLI_ORIGINATOR_MODELS = new Set(['gpt-5.6-luna']);
const CODEX_CLI_ORIGINATOR = 'codex_cli_rs';
const CODEX_CLI_VERSION = '0.144.1';

export function setCodexOriginatorHeaders(headers: Headers, model: string | undefined): void {
  if (model && CODEX_CLI_ORIGINATOR_MODELS.has(model)) {
    headers.set('originator', CODEX_CLI_ORIGINATOR);
    headers.set('version', CODEX_CLI_VERSION);
  } else {
    headers.set('originator', 'pi');
  }
}
export const OPENAI_REALTIME_MODELS = new Set(catalogModelIdsWithCapability('openai_codex', 'realtime'));

function normalizeOpenAiRealtimeModel(model: unknown): string {
  const raw = typeof model === 'string' && model.trim() ? model.trim() : OPENAI_REALTIME_DEFAULT_MODEL;
  if (/^gpt-realtime-2$/i.test(raw) || /^gpt[-_ ]?realtime[-_ ]?2$/i.test(raw)) return 'gpt-realtime-2';
  if (/^gpt-realtime$/i.test(raw) || /^gpt[-_ ]?realtime$/i.test(raw)) return 'gpt-realtime';
  return raw;
}

function normalizeRealtimeClientSecretBody(input: any, model: string): any {
  const raw = { ...(input || {}) };
  if (raw.session && typeof raw.session === 'object') {
    const { model: _model, type: _type, ...topLevel } = raw;
    return { ...topLevel, session: { ...raw.session, type: raw.session.type || 'realtime', model } };
  }
  const { model: _model, voice, instructions, modalities, audio, tools, tool_choice, ...rest } = raw;
  const body: any = { ...rest, session: { type: 'realtime', model } };
  if (audio != null) body.session.audio = audio;
  if (voice != null) body.session.audio = { ...(body.session.audio || {}), output: { ...((body.session.audio || {}).output || {}), voice } };
  if (instructions != null) body.session.instructions = instructions;
  if (modalities != null) body.session.modalities = modalities;
  if (tools != null) body.session.tools = tools;
  if (tool_choice != null) body.session.tool_choice = tool_choice;
  return body;
}

export const DEFAULT_IMAGE_INSTRUCTIONS = 'Use the image_generation tool to fulfill the user request. Respond with the generated image.';
const MAX_IMAGE_INSTRUCTIONS_CHARS = 8000;

export function resolveImageInstructions(body: any): string {
  const raw = typeof body?.instructions === 'string' && body.instructions.trim()
    ? body.instructions
    : typeof body?.system === 'string' && body.system.trim()
      ? body.system
      : '';
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_IMAGE_INSTRUCTIONS_CHARS) : DEFAULT_IMAGE_INSTRUCTIONS;
}

export function formatOpenAiErrorMessage(kind: string, detail?: any): string {
  if (kind === 'content_filter') return '⛔ OpenAI safety filter blocked this response (content_filter).';
  if (kind === 'max_output_tokens') return '[truncated: max_output_tokens]';
  if (kind === 'length') return '[truncated: length]';
  if (kind === 'response_failed') {
    const message = typeof detail?.message === 'string' && detail.message ? detail.message : 'unknown error';
    return `⚠️ OpenAI stream failed: ${message}`;
  }
  if (kind === 'codex_refresh_failed') return 'Your Codex OAuth session expired; please re-link via the dashboard.';
  if (kind === 'refusal') {
    const text = typeof detail === 'string' && detail ? detail : 'The model refused this request.';
    return `⛔ Refused: ${text}`;
  }
  return typeof detail?.message === 'string' ? detail.message : String(kind || 'OpenAI error');
}

export function classifyOpenAiStreamError(detail: any): { retryable: boolean; status: number; body: string } {
  const body = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
  const lower = body.toLowerCase();
  if (lower.includes('rate_limit') || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('usage_limit') || lower.includes('quota')) {
    return { retryable: true, status: 429, body };
  }
  if (lower.includes('server_is_overloaded') || lower.includes('overloaded') || lower.includes('service_unavailable') || lower.includes('temporarily unavailable') || lower.includes('timeout')) {
    return { retryable: true, status: 503, body };
  }
  if (lower.includes('internal_error') || lower.includes('internal server error') || lower.includes('bad gateway') || lower.includes('gateway timeout')) {
    return { retryable: true, status: 502, body };
  }
  return { retryable: false, status: 500, body };
}

function responsesMessageItem(text: string): any {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

export function injectResponsesMessageItem(parsed: any, text: string): any {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (!Array.isArray(parsed.output)) parsed.output = [];
  parsed.output.push(responsesMessageItem(text));
  return parsed;
}

export function buildResponsesStreamErrorEvents(text: string, outputIndex = 0): string {
  const item = responsesMessageItem(text);
  item.id = `msg_gateway_${outputIndex}`;
  const payload = { type: 'response.output_item.added', output_index: outputIndex, item };
  return `event: response.output_item.added
data: ${JSON.stringify(payload)}

`;
}

function extractRefusalText(item: any): string {
  if (typeof item?.refusal === 'string' && item.refusal) return item.refusal;
  if (typeof item?.text === 'string' && item.text) return item.text;
  if (typeof item?.content === 'string' && item.content) return item.content;
  if (Array.isArray(item?.content)) {
    const text = item.content.map((p: any) => p?.text || p?.refusal || p?.content || '').filter(Boolean).join('\n');
    if (text) return text;
  }
  return 'The model refused this request.';
}

function appendResponsesTailText(parsed: any, text: string): void {
  if (!parsed || typeof parsed !== 'object') return;
  if (!Array.isArray(parsed.output) || parsed.output.length === 0) {
    injectResponsesMessageItem(parsed, text);
    return;
  }
  for (let i = parsed.output.length - 1; i >= 0; i--) {
    const item = parsed.output[i];
    if (item?.type === 'message') {
      if (!Array.isArray(item.content)) item.content = [];
      item.content.push({ type: 'output_text', text, annotations: [] });
      return;
    }
  }
  injectResponsesMessageItem(parsed, text);
}

function normalizeOpenAiResponse(endpoint: '/v1/responses' | '/v1/chat/completions', text: string): { text: string; forcedLogReason?: string; forcedLogDetails?: any; usage: any } {
  let usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  let forcedLogReason: string | undefined;
  let forcedLogDetails: any;
  try {
    const parsed = JSON.parse(text);
    const u = parsed?.usage || parsed?.response?.usage;
    if (u) {
      usage = {
        inputTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
        outputTokens: u.output_tokens ?? u.completion_tokens ?? 0,
        cacheCreationTokens: 0,
        cacheReadTokens: u.input_tokens_details?.cached_tokens ?? 0,
        // Responses API: output_tokens_details; chat-compat: completion_tokens_details.
        reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    }

    if (endpoint === '/v1/responses') {
      if (parsed?.incomplete_details?.reason === 'content_filter' && (!Array.isArray(parsed.output) || parsed.output.length === 0)) {
        injectResponsesMessageItem(parsed, formatOpenAiErrorMessage('content_filter'));
        forcedLogReason = 'openai_content_filter';
        forcedLogDetails = { incomplete_details: parsed.incomplete_details };
      }
      if (parsed?.incomplete_details?.reason === 'max_output_tokens') {
        appendResponsesTailText(parsed, formatOpenAiErrorMessage('max_output_tokens'));
      }
      if (Array.isArray(parsed.output)) {
        const rewritten: any[] = [];
        for (const item of parsed.output) {
          rewritten.push(item);
          if (item?.type === 'refusal') {
            const refusalText = extractRefusalText(item);
            rewritten.push(responsesMessageItem(formatOpenAiErrorMessage('refusal', refusalText)));
            forcedLogReason = forcedLogReason || 'openai_refusal';
            forcedLogDetails = forcedLogDetails || { refusal: item };
          }
        }
        parsed.output = rewritten;
      }
    } else if (endpoint === '/v1/chat/completions' && Array.isArray(parsed?.choices)) {
      for (const choice of parsed.choices) {
        if (choice?.finish_reason === 'content_filter') {
          if (!choice.message || typeof choice.message !== 'object') choice.message = { role: 'assistant' };
          choice.message.content = formatOpenAiErrorMessage('content_filter');
          forcedLogReason = forcedLogReason || 'openai_chat_content_filter';
          forcedLogDetails = forcedLogDetails || { finish_reason: 'content_filter' };
        } else if (choice?.finish_reason === 'length' && typeof choice?.message?.content === 'string' && choice.message.content.length > 0) {
          choice.message.content += `

${formatOpenAiErrorMessage('length')}`;
        }
      }
    }

    return { text: JSON.stringify(parsed), forcedLogReason, forcedLogDetails, usage };
  } catch {
    return { text, forcedLogReason, forcedLogDetails, usage };
  }
}

function modelNotAllowedForUserError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', code: 'model_not_allowed_for_user', message } };
}

function textFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => typeof p === 'string' ? p : (p?.text || p?.content || '')).filter(Boolean).join('\n');
  return content == null ? '' : String(content);
}

function toCodexInputItem(role: string, content: any): any {
  const text = textFromContent(content);
  return { type: 'message', role: role === 'assistant' ? 'assistant' : 'user', content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] };
}

// When the Codex pool rotates off the account that produced a turn's reasoning
// (e.g. the sticky account hit an overload/cooldown), the new account cannot
// decrypt the prior account's `encrypted_content`, yielding a hard
// 400 invalid_encrypted_content. Stripping the stale reasoning items lets the
// request succeed on the new account at the cost of that turn's reasoning
// continuity. Normal same-account traffic never hits this path.
// Removes ONLY stale encrypted reasoning items (type 'reasoning' carrying an
// `encrypted_content` blob). Reasoning summaries without encrypted_content and
// all other input item types are left untouched. Returns the number stripped so
// callers only retry when something actually changed.
export function stripEncryptedReasoning(body: any): { body: any; stripped: number } {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return { body, stripped: 0 };
  let stripped = 0;
  const input = body.input.filter((item: any) => {
    if (item && typeof item === 'object' && item.type === 'reasoning' && 'encrypted_content' in item) {
      stripped += 1;
      return false;
    }
    return true;
  });
  if (!stripped) return { body, stripped: 0 };
  return { body: { ...body, input }, stripped };
}

export function isEncryptedContentError(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.code || parsed?.code;
    if (typeof code === 'string' && code.toLowerCase() === 'invalid_encrypted_content') return true;
  } catch {}
  // Fall back to the specific error token only (not the looser "encrypted content"
  // phrase) so unrelated client 400s don't trigger a strip+retry.
  return /invalid_encrypted_content/i.test(body || '');
}

// Redacts Fernet-style encrypted_content blobs (gAAAA...) that providers may echo
// back in error messages, so forced diagnostic logs never persist them.
export function redactEncryptedBlobs(text: string): string {
  return (text || '').replace(/gAAAA[A-Za-z0-9_\-=]{8,}/g, 'gAAAA[redacted]');
}

function prepareCodexBody(body: any, endpoint: string): any {
  const out: any = { ...(body || {}) };
  if (endpoint === '/v1/chat/completions' && Array.isArray(out.messages) && !out.input) {
    const system = out.messages.filter((m: any) => m?.role === 'system' || m?.role === 'developer').map((m: any) => textFromContent(m.content)).filter(Boolean).join('\n');
    out.input = out.messages.filter((m: any) => m?.role !== 'system' && m?.role !== 'developer').map((m: any) => toCodexInputItem(m?.role || 'user', m?.content));
    if (system && !out.instructions) out.instructions = system;
    delete out.messages;
  } else if (typeof out.input === 'string') {
    out.input = [toCodexInputItem('user', out.input)];
  } else if (Array.isArray(out.input) && out.input.length && typeof out.input[0] === 'string') {
    out.input = out.input.map((text: string) => toCodexInputItem('user', text));
  }
  if (Array.isArray(out.input)) {
    const liftedInstructions = out.input
      .filter((item: any) => item?.type === 'message' && (item?.role === 'system' || item?.role === 'developer'))
      .map((item: any) => textFromContent(item.content))
      .filter(Boolean)
      .join('\n');
    out.input = out.input.filter((item: any) => !(item?.type === 'message' && (item?.role === 'system' || item?.role === 'developer')));
    if (liftedInstructions) out.instructions = out.instructions ? `${out.instructions}\n${liftedInstructions}` : liftedInstructions;
  }
  if (!Array.isArray(out.input) || out.input.length === 0) out.input = [toCodexInputItem('user', '')];
  if (!out.instructions) out.instructions = 'You are a helpful assistant.';
  out.store = false;
  // ChatGPT Codex backend requires streaming even when the external client requested non-stream.
  out.stream = true;
  delete out.max_output_tokens;
  delete out.temperature;
  delete out.top_p;
  delete out.stop;
  delete out.top_k;
  return out;
}

async function forwardOpenAiCompatible(req: any, reply: any, endpoint: '/v1/responses' | '/v1/chat/completions') {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const body = req.body as any;
  const model = typeof body?.model === 'string' ? body.model : undefined;
  const stream = !!body?.stream;
  const allowed = isModelAllowedForUser(auth.user, 'openai_codex', model);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'openai_codex', auth.token, model);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || body?.previous_response_id || '');
  const stickyKey = `${auth.user.email}:${auth.token.label}:${conversationId || model || endpoint}`;

  const codexCandidates = selectStickyCodexAccounts(stickyKey, [], auth.user.email, model);
  const attempts = codexCandidates.length ? Math.min(3, codexCandidates.length) : 1;
  const triedCodexIds: number[] = [];
  let lastError = 'No Codex/OpenAI account available';
  let anyCodexRefreshFailed = false;
  // Mutable copy of the request body so a recoverable strip (encrypted reasoning)
  // persists across retries instead of re-sending the poisoned body each time.
  let workingBody = body;
  let encryptedContentStripped = false;
  // Grants exactly one extra attempt when we strip encrypted reasoning, reusing
  // the same account so the stripped body can succeed even if it was the last
  // candidate. Capped so it cannot loop.
  let bonusAttempts = 0;
  let forceReuseAccount: any = null;
  // Why the previous attempt failed — recorded as retry_reason on the attempt
  // that eventually succeeds (attempt > 0 means we rotated/retried at least once).
  let lastRetryReason: 'rate_limited' | 'account_rotation' | 'stale_reasoning' | 'upstream_error' | undefined;

  for (let attempt = 0; attempt < attempts + bonusAttempts; attempt++) {
    let account: any;
    // Guarded release: every codepath that aborts after acquiring a slot must
    // call release() before `continue`/`return`. The `released` flag makes
    // double-release safe (e.g., success path releases, then the outer catch
    // also fires) so we don't double-decrement the in-flight counter.
    let released = false;
    let release: (usage?: any) => void = () => {};
    if (codexCandidates.length) {
      account = forceReuseAccount || (attempt === 0 ? codexCandidates[0] : selectStickyCodexAccounts(stickyKey, triedCodexIds, auth.user.email, model)[0]);
      forceReuseAccount = null;
      if (!account) break;
      if (!triedCodexIds.includes(account.id)) triedCodexIds.push(account.id);
      // Concurrency cap. acquireCodexSlot returns false if at max; try the next
      // candidate. If all candidates are saturated, the loop falls through and
      // returns 503 like Anthropic.
      if (!acquireCodexSlot(account)) {
        lastError = 'Codex account at concurrency cap';
        continue;
      }
      release = () => { if (!released) { released = true; releaseCodexSlot(account); } };
    } else {
      const selection = selectAccount('openai', stickyKey + ':' + attempt);
      if (!selection) break;
      account = selection.account;
      const inner = selection.release;
      release = (usage?: any) => { if (!released) { released = true; inner(usage); } };
    }

    try {
      const isCodex = account.provider === 'openai_codex';
      const fresh = isCodex ? await ensureFreshCodexAccount(account) : account;
      if (!fresh) {
        // Refresh failed on THIS account. Mark it invalid, log per-account so
        // ops can see which session expired, but DO NOT surface to the client
        // yet — the retry loop should try other accounts in the pool. Only if
        // the entire loop exhausts do we return a 503 (handled below).
        const message = formatOpenAiErrorMessage('codex_refresh_failed');
        lastError = message;
        anyCodexRefreshFailed = true;
        if (isCodex) markCodexInvalid(account, 'codex oauth refresh failed');
        release();
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: 401, latencyMs: Date.now() - started, error: message, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        logRequestResponse({
          usageEventId,
          userId: auth.user.id,
          requestBody: { forcedLogReason: 'codex_refresh_failed', providerAccountLabel: account.label, attempt: attempt + 1, headers: req.headers, body },
          responseText: JSON.stringify(openAiError(message, 'authentication_error', 'codex_refresh_failed')),
        });
        continue;
      }
      const headers = new Headers();
      headers.set('content-type', 'application/json');
      headers.set('authorization', `Bearer ${fresh.secret}`);
      if (isCodex && fresh.account_id) {
        headers.set('chatgpt-account-id', fresh.account_id);
        setCodexOriginatorHeaders(headers, model);
      }
      headers.set('openai-beta', String(req.headers['openai-beta'] || 'responses=experimental'));
      headers.set('accept', stream ? 'text/event-stream' : 'application/json');

      const upstreamUrl = isCodex
        ? `${config.openaiUpstreamUrl}/codex/responses`
        : `${config.openaiUpstreamUrl}${endpoint}`;

      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(isCodex ? prepareCodexBody(workingBody, endpoint) : workingBody),
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });

      reply.header('x-gateway-provider', account.provider);
      reply.header('x-gateway-account', account.label);
      reply.header('x-gateway-attempt', String(attempt + 1));

      if (upstream.status >= 400) {
        const text = await upstream.text();
        lastError = text.slice(0, 500) || String(upstream.status);
        if (isCodex) {
          release();
          // Recoverable cross-account reasoning failure: the account we rotated to
          // cannot decrypt the prior account's reasoning. Strip the stale
          // encrypted reasoning and retry the SAME account once; do not penalize
          // the account (it is healthy) and do not surface a 400 to the client.
          if (isEncryptedContentError(upstream.status, text) && !encryptedContentStripped) {
            const strip = stripEncryptedReasoning(workingBody);
            // Only retry when we actually removed stale encrypted reasoning;
            // otherwise fall through to normal 400 handling (no pointless resend).
            if (strip.stripped > 0) {
              encryptedContentStripped = true;
              workingBody = strip.body;
              lastRetryReason = 'stale_reasoning';
              const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: upstream.status, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
              const diagnosticRequest = { forcedLogReason: 'codex_encrypted_content_stripped', providerAccountLabel: account.label, attempt: attempt + 1, status: upstream.status, strippedReasoningItems: strip.stripped };
              logRequestResponse({
                usageEventId,
                userId: auth.user.id,
                requestBody: shouldLogBody(auth.user) ? { ...diagnosticRequest, headers: req.headers, body } : diagnosticRequest,
                // Never persist the raw 400 body (can echo encrypted blobs/PII).
                responseText: shouldLogBody(auth.user) ? redactEncryptedBlobs(text.slice(0, 2000)) : 'invalid_encrypted_content (stripped stale reasoning, retried)',
              });
              forceReuseAccount = account;
              // Always grant exactly one bonus attempt for the stripped retry so it
              // never consumes the normal failover budget (capped once by
              // encryptedContentStripped above).
              bonusAttempts += 1;
              continue;
            }
          }
          const classification = classifyCodexUpstreamError(upstream.status, text, upstream.headers.get('retry-after'));
          if (classification.kind === 'rate_limit') {
            markCodexBucketRateLimited(
              account,
              model,
              classification.cooldownMs ?? 45_000,
              classification.quotaExhausted ? `quota exhausted (${upstream.status})` : `rate limited (${upstream.status})`,
              classification.resetsAt,
            );
          }
          else if (classification.kind === 'auth_invalid') markCodexInvalid(account, `auth invalid (${upstream.status})`);
          else if (classification.retryable) markCodexTemporaryFailure(account, `temporary upstream failure (${upstream.status})`);
          lastRetryReason = classification.kind === 'rate_limit' ? 'rate_limited' : 'account_rotation';
          recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: upstream.status, latencyMs: Date.now() - started, error: lastError, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          if (classification.retryable && attempt < attempts + bonusAttempts - 1) continue;
          reply.code(upstream.status).type('application/json').send(text || openAiError(classification.kind));
          return;
        }
        const kind = classifyProviderError(upstream.status, text);
        if (kind === 'rate_limit') markCooldown(account.id, 15 * 60 * 1000, 'rate_limit');
        else if (kind === 'dead') markDead(account.id, 'auth_invalid');
        else if (kind === 'permission') markCooldown(account.id, 60 * 60 * 1000, 'permission');
        else if (kind === 'temporary') markCooldown(account.id, 60_000, 'temporary');
        lastRetryReason = kind === 'rate_limit' ? 'rate_limited' : 'account_rotation';
        release();
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: upstream.status, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        reply.code(upstream.status).type('application/json').send(text || openAiError(kind));
        return;
      }

      if (stream && upstream.body) {
        const bufferCodexEarlyFailures = isCodex && endpoint === '/v1/responses';
        const responseHeaders = { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', 'x-gateway-provider': account.provider, 'x-gateway-account': account.label };
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let assembled = '';
        let pending = '';
        let bufferedSse = '';
        let streamHeadersSent = false;
        let successMarked = false;
        let earlyStreamFailure: { status: number; body: string; error: any } | undefined;
        let lastUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
        let ttftMs: number | undefined;
        let forcedLogReason: string | undefined;
        let forcedLogDetails: any;
        let seenOutputItems = 0;
        // True once any SSE event other than pure setup (response.created /
        // response.in_progress) is parsed. Distinguishes a genuinely empty
        // setup-only stream from one that buffered a meaningful event (refusal,
        // non-retryable response.failed, output, completion) without flushing.
        let sawNonSetupEvent = false;
        const seenRefusals = new Set<string>();
        const markSuccessAndRelease = () => {
          if (successMarked) return;
          successMarked = true;
          if (isCodex) { markCodexSuccess(account); release(); } else release();
        };
        const sendHeadersIfNeeded = () => {
          if (streamHeadersSent) return;
          writeRawResponseHead(reply, upstream.status, responseHeaders);
          streamHeadersSent = true;
          markSuccessAndRelease();
          if (bufferedSse) {
            reply.raw.write(bufferedSse);
            bufferedSse = '';
          }
        };
        if (!bufferCodexEarlyFailures) sendHeadersIfNeeded();
        const tryAbsorbUsage = (evt: any) => {
          const u = evt?.response?.usage || evt?.usage;
          if (!u) return;
          lastUsage = {
            inputTokens: u.input_tokens ?? u.prompt_tokens ?? lastUsage.inputTokens,
            outputTokens: u.output_tokens ?? u.completion_tokens ?? lastUsage.outputTokens,
            cacheCreationTokens: u.input_tokens_details?.cached_tokens ? 0 : lastUsage.cacheCreationTokens,
            cacheReadTokens: u.input_tokens_details?.cached_tokens ?? lastUsage.cacheReadTokens,
            reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? lastUsage.reasoningTokens,
          };
        };
        const shouldFlushBufferedStream = (type: string, eventName: string) => {
          if (!bufferCodexEarlyFailures || streamHeadersSent) return false;
          const name = type || eventName;
          // Keep the retry window open through structural/setup events. Codex can
          // emit response.output_item.added/content_part.added before any visible
          // text/tool/audio delta, then still fail with server_is_overloaded.
          // Flush only once real output starts, or when the stream completes
          // successfully without an earlier retryable failure.
          return name.endsWith('.delta') || name === 'response.completed';
        };
        const maybeCaptureEarlyFailure = (evt: any, type: string, eventName: string) => {
          if (!bufferCodexEarlyFailures || streamHeadersSent) return false;
          if (type !== 'response.failed' && type !== 'error' && eventName !== 'error') return false;
          const error = evt?.response?.error || evt?.error || evt;
          const classified = classifyOpenAiStreamError(error);
          if (!classified.retryable) return false;
          earlyStreamFailure = { status: classified.status, body: classified.body, error };
          forcedLogReason = forcedLogReason || 'codex_early_stream_failure';
          forcedLogDetails = forcedLogDetails || { error };
          return true;
        };
        const writeSse = (chunk: string) => {
          if (!chunk) return;
          assembled += chunk;
          if (streamHeadersSent) reply.raw.write(chunk);
          else bufferedSse += chunk;
        };
        const handleSseEvent = (event: string) => {
          const original = `${event}\n\n`;
          const lines = event.split(/\r?\n/);
          const eventName = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() || '';
          const dataPayload = lines
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!dataPayload) {
            // Heartbeat/comment frames are not real output. For Codex early-failure
            // buffering, retain them until an actual output delta/completion so an
            // immediately-following overload can still retry another account.
            writeSse(original);
            return;
          }
          if (dataPayload === '[DONE]') {
            sendHeadersIfNeeded();
            writeSse(original);
            return;
          }
          let before = '';
          let after = '';
          try {
            const evt = JSON.parse(dataPayload);
            tryAbsorbUsage(evt);
            const type = evt?.type || eventName;
            if (type && type !== 'response.created' && type !== 'response.in_progress') sawNonSetupEvent = true;
            if (maybeCaptureEarlyFailure(evt, type, eventName)) {
              writeSse(original);
              return;
            }
            if (shouldFlushBufferedStream(type, eventName)) sendHeadersIfNeeded();
            if (endpoint === '/v1/responses') {
              if (type === 'response.output_item.added') seenOutputItems = Math.max(seenOutputItems, Number(evt.output_index ?? seenOutputItems) + 1);
              const item = evt?.item;
              if (item?.type === 'refusal') {
                const key = String(item.id || `${type}:${seenOutputItems}:${extractRefusalText(item)}`);
                if (!seenRefusals.has(key)) {
                  seenRefusals.add(key);
                  after += buildResponsesStreamErrorEvents(formatOpenAiErrorMessage('refusal', extractRefusalText(item)), seenOutputItems++);
                  forcedLogReason = forcedLogReason || 'openai_refusal';
                  forcedLogDetails = forcedLogDetails || { refusal: item };
                }
              }
              if (type === 'response.failed') {
                const error = evt?.response?.error || evt?.error || {};
                before += buildResponsesStreamErrorEvents(formatOpenAiErrorMessage('response_failed', error), seenOutputItems++);
                forcedLogReason = forcedLogReason || 'openai_response_failed';
                forcedLogDetails = forcedLogDetails || { error };
              }
            } else if (endpoint === '/v1/chat/completions' && Array.isArray(evt?.choices)) {
              const lengthChoices = evt.choices.filter((choice: any) => choice?.finish_reason === 'length');
              for (const choice of lengthChoices) {
                before += `data: ${JSON.stringify({
                  id: evt.id,
                  object: evt.object || 'chat.completion.chunk',
                  created: evt.created,
                  model: evt.model,
                  choices: [{ index: choice.index ?? 0, delta: { content: `\n\n${formatOpenAiErrorMessage('length')}` }, finish_reason: null }],
                })}\n\n`;
              }
            }
          } catch {}
          writeSse(before);
          writeSse(original);
          writeSse(after);
        };
        const consumeEvents = (force = false) => {
          let sepIdx;
          while (!earlyStreamFailure && (sepIdx = pending.indexOf('\n\n')) !== -1) {
            const event = pending.slice(0, sepIdx);
            pending = pending.slice(sepIdx + 2);
            handleSseEvent(event);
          }
          if (!earlyStreamFailure && force && pending.trim()) {
            handleSseEvent(pending);
            pending = '';
          }
        };
        while (!earlyStreamFailure) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ttftMs === undefined) ttftMs = Date.now() - started;
          pending += decoder.decode(value, { stream: true });
          consumeEvents(false);
        }
        pending += decoder.decode();
        consumeEvents(true);
        // Silent empty stream: upstream sent only setup events (response.created /
        // in_progress) then closed without any output delta, completion, or error.
        // Because nothing was flushed, this is still recoverable — treat it like an
        // early retryable failure so the pool can fail over instead of emitting a
        // 200 with zero tokens.
        const upstreamIsEventStream = (upstream.headers.get('content-type') || '').includes('text/event-stream');
        if (bufferCodexEarlyFailures && upstreamIsEventStream && !streamHeadersSent && !earlyStreamFailure && !sawNonSetupEvent && !forcedLogReason) {
          earlyStreamFailure = {
            status: 502,
            body: 'Upstream closed the stream before producing any output',
            error: { type: 'empty_stream_error', code: 'empty_response', message: 'Upstream closed the stream before producing any output' },
          };
          forcedLogReason = forcedLogReason || 'codex_empty_stream';
          forcedLogDetails = forcedLogDetails || { reason: 'empty_stream', sequencesSeen: seenOutputItems };
        }
        if (earlyStreamFailure) {
          try { await reader.cancel(); } catch {}
          lastError = earlyStreamFailure.body.slice(0, 500) || 'early OpenAI stream failure';
          release();
          if (isCodex) {
            const classification = classifyCodexUpstreamError(earlyStreamFailure.status, earlyStreamFailure.body);
            if (classification.kind === 'rate_limit') {
              markCodexBucketRateLimited(
                account,
                model,
                classification.cooldownMs ?? 45_000,
                classification.quotaExhausted ? `quota exhausted (${earlyStreamFailure.status})` : `rate limited (${earlyStreamFailure.status})`,
                classification.resetsAt,
              );
            }
            else if (classification.kind === 'auth_invalid') markCodexInvalid(account, `auth invalid (${earlyStreamFailure.status})`);
            else if (classification.retryable) markCodexTemporaryFailure(account, `temporary upstream stream failure (${earlyStreamFailure.status})`);
          }
          const cost = estimateCost(model, lastUsage, account.provider);
          const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: earlyStreamFailure.status, inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens, cacheCreationTokens: lastUsage.cacheCreationTokens, cacheReadTokens: lastUsage.cacheReadTokens, estimatedCostUsd: cost, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
          enforceAfterUsage(auth.user, account.provider, auth.token, model);
          const diagnosticRequest = { forcedLogReason: forcedLogReason || 'early_stream_failure', providerAccountLabel: account.label, attempt: attempt + 1, details: forcedLogDetails || { error: earlyStreamFailure.error }, status: earlyStreamFailure.status };
          logRequestResponse({
            usageEventId,
            userId: auth.user.id,
            requestBody: shouldLogBody(auth.user) ? { ...diagnosticRequest, headers: req.headers, body } : diagnosticRequest,
            // `assembled` holds buffered upstream setup events (instructions/tool
            // config can be prompt-adjacent). Only persist it under full-body
            // logging; otherwise store a minimal sanitized summary.
            responseText: shouldLogBody(auth.user)
              ? assembled
              : JSON.stringify({ forcedLogReason: forcedLogReason || 'early_stream_failure', status: earlyStreamFailure.status, bufferedBytes: assembled.length }),
          });
          if (isCodex && attempt < attempts + bonusAttempts - 1) continue;
          reply.code(earlyStreamFailure.status).type('application/json').send(openAiError(`OpenAI/Codex stream failed before output: ${formatOpenAiErrorMessage('response_failed', earlyStreamFailure.error)}`, 'server_error', 'stream_failed'));
          return;
        }
        sendHeadersIfNeeded();
        reply.raw.end();
        const cost = estimateCost(model, lastUsage, account.provider);
        const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: upstream.status, inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens, cacheCreationTokens: lastUsage.cacheCreationTokens, cacheReadTokens: lastUsage.cacheReadTokens, reasoningTokens: lastUsage.reasoningTokens || undefined, estimatedCostUsd: cost, latencyMs: Date.now() - started, ttftMs, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        enforceAfterUsage(auth.user, account.provider, auth.token, model);
        if (shouldLogBody(auth.user)) {
          logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: assembled });
        } else if (forcedLogReason) {
          logRequestResponse({
            usageEventId,
            userId: auth.user.id,
            requestBody: { forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, details: forcedLogDetails, headers: req.headers, body },
            responseText: assembled,
          });
        }
        return;
      }

      const upstreamText = await upstream.text();
      const nonStreamTtftMs = Date.now() - started; // full-body receipt (≈ latency for non-stream)
      if (isCodex) { markCodexSuccess(account); release(); } else release();
      const normalized = normalizeOpenAiResponse(endpoint, upstreamText);
      const text = normalized.text;
      const usage = normalized.usage;
      const cost = estimateCost(model, usage, account.provider);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: upstream.status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheCreationTokens: usage.cacheCreationTokens, cacheReadTokens: usage.cacheReadTokens, reasoningTokens: usage.reasoningTokens || undefined, estimatedCostUsd: cost, latencyMs: Date.now() - started, ttftMs: nonStreamTtftMs, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, account.provider, auth.token, model);
      if (shouldLogBody(auth.user)) {
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: body, responseText: text });
      } else if (normalized.forcedLogReason) {
        logRequestResponse({
          usageEventId,
          userId: auth.user.id,
          requestBody: { forcedLogReason: normalized.forcedLogReason, providerAccountLabel: account.label, attempt: attempt + 1, details: normalized.forcedLogDetails, headers: req.headers, body },
          responseText: text,
        });
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      lastError = err?.message || String(err);
      if (account?.provider === 'openai_codex') {
        release();
        markCodexTemporaryFailure(account, `proxy error: ${lastError.slice(0, 200)}`);
      } else { markCooldown(account.id, 60_000, 'network_error'); release(); }
      lastRetryReason = 'upstream_error';
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: account.provider, endpoint, model, stream, statusCode: 502, latencyMs: Date.now() - started, error: lastError, retryCount: attempt, retryReason: attempt > 0 ? lastRetryReason : undefined, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      if (account?.provider === 'openai_codex' && attempt < attempts + bonusAttempts - 1) continue;
    }
  }

  reply.header('retry-after', '60');
  reply.header('x-gateway-provider', 'openai_codex');
  if (anyCodexRefreshFailed && /codex oauth session expired|codex oauth refresh|codex_refresh_failed/i.test(lastError)) {
    reply.code(401).send(openAiError('All available Codex OAuth sessions have expired; please re-link via the dashboard.', 'authentication_error', 'codex_refresh_failed'));
    return;
  }
  reply.code(503).send(openAiError(`OpenAI/Codex capacity unavailable: ${lastError}`, 'server_error', 'service_unavailable'));
}


function parseMultipartBoundary(contentType: string): string | null {
  const m = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType);
  return (m?.[1] || m?.[2] || '').trim() || null;
}

function parseOpenAiImageMultipart(bodyBuf: Buffer, contentType: string): any | null {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) return null;
  const raw = `\r\n${bodyBuf.toString('binary')}`;
  const parts = raw.split(`\r\n--${boundary}`).slice(1, -1);
  const out: any = {};
  const images: any[] = [];
  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = trimmed.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const headerText = trimmed.slice(0, sep);
    const bodyText = trimmed.slice(sep + 4);
    const name = /name="([^"]+)"/i.exec(headerText)?.[1];
    if (!name) continue;
    const fileName = /filename="([^"]*)"/i.exec(headerText)?.[1];
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || 'application/octet-stream';
    const bytes = Buffer.from(bodyText, 'binary');
    if (fileName != null || name === 'image' || name === 'image[]') {
      if (name === 'image' || name === 'image[]') images.push(`data:${partType};base64,${bytes.toString('base64')}`);
      continue;
    }
    out[name] = bytes.toString('utf8').replace(/\r\n$/, '');
  }
  if (images.length === 1) out.image = images[0];
  else if (images.length > 1) out.image = images;
  return out;
}

function normalizeOpenAiImageRequest(req: any): { body: any; rawMultipart?: Buffer; rawContentType?: string; logBody: any } {
  const contentType = String(req.headers['content-type'] || '');
  const isMultipart = /^multipart\/form-data/i.test(contentType);
  if (isMultipart && Buffer.isBuffer(req.body)) {
    const parsed = parseOpenAiImageMultipart(req.body, contentType) || {};
    return {
      body: parsed,
      rawMultipart: req.body,
      rawContentType: contentType,
      logBody: { multipart: true, fields: Object.keys(parsed).filter((k) => k !== 'image'), imageCount: Array.isArray(parsed.image) ? parsed.image.length : parsed.image ? 1 : 0 },
    };
  }
  return { body: req.body as any, logBody: req.body as any };
}

async function forwardOpenAiImage(req: any, reply: any, endpoint: '/images/generations' | '/images/edits') {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const normalizedReq = normalizeOpenAiImageRequest(req);
  const body = normalizedReq.body as any;
  const model = typeof body?.model === 'string' ? body.model : undefined;
  if (endpoint === '/images/edits' && normalizedReq.rawMultipart && !body?.image) {
    reply.code(400).send(openAiError('OpenAI image edits multipart request requires at least one image field', 'invalid_request_error', 'missing_image'));
    return;
  }
  const openAiAllowed = isModelAllowedForUser(auth.user, 'openai', model);
  const codexAllowed = isModelAllowedForUser(auth.user, 'openai_codex', model);
  if (!openAiAllowed.ok && !codexAllowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(openAiAllowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'openai', auth.token, model);
  if (openAiAllowed.ok && !limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  // Image generation requires a real OpenAI API-key account (provider='openai').
  // Codex/ChatGPT OAuth does not expose /v1/images/* endpoints.
  const accounts = (await import('../db/index.js')).getDb().prepare(`
    SELECT id,provider,label,secret,enabled,status,max_in_flight,cooldown_until
    FROM provider_accounts
    WHERE provider='openai' AND enabled=1 AND status NOT IN ('dead','disabled','invalid','refresh_failed')
      AND (cooldown_until IS NULL OR cooldown_until <= ?)
    ORDER BY id
  `).all(Date.now()) as any[];
  if (!accounts.length || !openAiAllowed.ok) {
    // No usable OpenAI API-key account. Fall back to Codex/ChatGPT OAuth via the
    // Responses API + image_generation tool. ChatGPT plans pay for these.
    return forwardOpenAiImageViaCodex(req, reply, endpoint, started, body);
  }
  const stickyKey = `${auth.user.email}:${auth.token.label}:${model || endpoint}`;
  // Hash the sticky key into the eligible accounts so repeated requests pin.
  const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); };
  const ordered = [...accounts].sort((a, b) => a.id - b.id);
  const primary = ordered[hash(stickyKey) % ordered.length];
  const candidates = [primary, ...accounts.filter((a) => a.id !== primary.id)];

  let lastError = 'No OpenAI account available';
  for (const account of candidates) {
    try {
      const headers = new Headers();
      // Forward client headers minus auth/host
      for (const [k, v] of Object.entries(req.headers)) {
        if (!v) continue;
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'content-length' || lk === 'authorization' || lk === 'x-api-key') continue;
        headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
      headers.set('content-type', normalizedReq.rawContentType || 'application/json');
      headers.set('authorization', `Bearer ${account.secret}`);

      const upstreamUrl = `${config.openaiPlatformUpstreamUrl}${endpoint}`;
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: normalizedReq.rawMultipart ? new Uint8Array(normalizedReq.rawMultipart) : JSON.stringify(body),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      reply.header('x-gateway-provider', 'openai');
      reply.header('x-gateway-account', account.label);

      const text = await upstream.text();
      if (upstream.status >= 400) {
        lastError = text.slice(0, 500) || String(upstream.status);
        const kind = classifyProviderError(upstream.status, text);
        if (kind === 'rate_limit') markCooldown(account.id, 15 * 60 * 1000, 'rate_limit');
        else if (kind === 'dead') markDead(account.id, 'auth_invalid');
        else if (kind === 'permission') markCooldown(account.id, 60 * 60 * 1000, 'permission');
        else if (kind === 'temporary') markCooldown(account.id, 60_000, 'temporary');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'openai', endpoint: `/v1${endpoint}`, model, stream: false, statusCode: upstream.status, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
        if (['rate_limit','temporary','dead','permission'].includes(kind) && account !== candidates[candidates.length - 1]) continue;
        reply.code(upstream.status).type('application/json').send(text || openAiError(kind));
        return;
      }

      // Success. Image responses don't carry token usage today; record metadata only.
      const cost = estimateCost(model, {}, 'openai');
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'openai', endpoint: `/v1${endpoint}`, model, stream: false, statusCode: upstream.status, estimatedCostUsd: cost, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
      enforceAfterUsage(auth.user, 'openai', auth.token, model);
      if (shouldLogBody(auth.user)) logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: normalizedReq.logBody, responseText: text });
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      lastError = err?.message || String(err);
      markCooldown(account.id, 60_000, 'network_error');
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'openai', endpoint: `/v1${endpoint}`, model, stream: false, statusCode: 502, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
    }
  }
  reply.header('x-gateway-provider', 'openai');
  reply.code(503).send(openAiError(`OpenAI image capacity unavailable: ${lastError}`, 'server_error', 'service_unavailable'));
}

// ─── Codex/ChatGPT OAuth adapter for image generation ─────────────────────
// Translates OpenAI Images API (/v1/images/{generations,edits}) into a
// Responses API call with the image_generation tool, sends to chatgpt.com,
// collects the base64 image from response.output_item.done events, and
// returns the OpenAI Images API response shape so clients (OCPlatform, OpenAI
// SDK, etc.) work unchanged.
//
// The heavy lifting lives in the reusable `runCodexImageJob` worker below so
// both the synchronous route and the async/poll-based routes share EXACTLY the
// same account selection, upstream stream-consume, marking, usage recording,
// and response shaping. The worker never touches `reply`; it returns a plain
// result object (including the headers the sync path must set) so the sync
// wrapper can reproduce its historical reply/status/headers byte-for-byte.
export type CodexImageJobResult =
  | { ok: true; status: number; responseShape: { created: number; data: Array<{ b64_json: string; revised_prompt?: string }> }; headers: Record<string, string>; accountLabel: string; usage: any }
  | { ok: false; status: number; errorBody: any; headers: Record<string, string>; accountLabel?: string };

// Reusable async worker. Performs the full Codex image job (account select +
// upstream Responses stream-consume) and RETURNS the result instead of writing
// to an HTTP reply. Caller is responsible for auth + model/limit guards (the
// sync wrapper and the async routes both run those up front). On success it
// records usage + enforces caps + logs body exactly as the legacy sync handler
// did, so billing/usage rows are identical regardless of sync vs async entry.
export async function runCodexImageJob(args: {
  user: any;
  token: any;
  endpoint: '/images/generations' | '/images/edits';
  body: any;
  started: number;
}): Promise<CodexImageJobResult> {
  const { user, token, endpoint, body, started } = args;
  const requestedModel = typeof body?.model === 'string' ? body.model : 'gpt-image-2';
  const respHeaders: Record<string, string> = {};

  const candidates = selectStickyCodexAccounts(`${user.email}:${token.label}:${requestedModel || endpoint}`, [], user.email, requestedModel);
  if (!candidates.length) {
    respHeaders['x-gateway-provider'] = 'openai_codex';
    return {
      ok: false,
      status: 503,
      errorBody: openAiError(
        'No OpenAI/Codex account available for image generation. Add an OpenAI API key (provider="openai") or onboard a Codex account.',
        'service_unavailable', 'no_image_provider',
      ),
      headers: respHeaders,
    };
  }

  // Build the Responses-API body from the Images-API request.
  const inputContent: any[] = [{ type: 'input_text', text: body.prompt || '' }];
  if (endpoint === '/images/edits' && body.image) {
    const images: any[] = Array.isArray(body.image) ? body.image : [body.image];
    for (const img of images) {
      // Image can be a base64 string, a data URL, or an object {image_url}.
      if (typeof img === 'string') {
        const url = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
        inputContent.push({ type: 'input_image', image_url: url });
      } else if (img && typeof img === 'object' && img.image_url) {
        inputContent.push({ type: 'input_image', image_url: img.image_url });
      }
    }
  }

  const tool: any = { type: 'image_generation' };
  if (requestedModel && requestedModel !== 'gpt-image-2') tool.model = requestedModel;
  if (body.size) tool.size = body.size;
  if (body.quality) tool.quality = body.quality;
  if (body.response_format === 'b64_json' || body.output_format) tool.output_format = body.output_format || 'png';
  if (body.background) tool.background = body.background;
  if (body.moderation) tool.moderation = body.moderation;
  if (body.output_compression != null) tool.output_compression = body.output_compression;
  // OpenAI Responses image_generation tool has no `n` parameter — the model
  // produces one image per tool call. To honor n>1, hint it in the prompt and
  // also add a system instruction so the model emits multiple tool calls.
  const desiredCount = Math.max(1, Math.min(8, Number(body.n) || 1));
  if (desiredCount > 1) {
    inputContent[0].text = `${inputContent[0].text}\n\nProduce ${desiredCount} distinct image variants by calling the image_generation tool ${desiredCount} times.`;
  }

  const codexBody = {
    model: 'gpt-5.5',
    input: [{ type: 'message', role: 'user', content: inputContent }],
    tools: [tool],
    tool_choice: { type: 'image_generation' } as any,
    instructions: resolveImageInstructions(body),
    store: false,
    stream: true,
  };

  let lastError = 'No Codex account succeeded';
  for (const account of candidates) {
    if (!acquireCodexSlot(account)) { lastError = 'Codex at concurrency cap'; continue; }
    try {
      const fresh = await ensureFreshCodexAccount(account);
      if (!fresh) { releaseCodexSlot(account); lastError = 'Codex refresh failed'; continue; }
      const headers = new Headers();
      headers.set('content-type', 'application/json');
      headers.set('authorization', `Bearer ${fresh.secret}`);
      if (fresh.account_id) headers.set('chatgpt-account-id', fresh.account_id);
      setCodexOriginatorHeaders(headers, requestedModel);
      headers.set('openai-beta', 'responses=experimental');
      headers.set('accept', 'text/event-stream');

      const upstream = await fetch(`${config.openaiUpstreamUrl}/codex/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(codexBody),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });

      respHeaders['x-gateway-provider'] = 'openai_codex';
      respHeaders['x-gateway-account'] = account.label;
      respHeaders['x-gateway-image-mode'] = 'codex-responses-tool';

      if (upstream.status >= 400 || !upstream.body) {
        const text = await upstream.text();
        releaseCodexSlot(account);
        lastError = text.slice(0, 500) || String(upstream.status);
        const cls = classifyCodexUpstreamError(upstream.status, text, upstream.headers.get('retry-after'));
        if (cls.kind === 'rate_limit') {
          markCodexBucketRateLimited(
            account,
            requestedModel,
            cls.cooldownMs ?? 45_000,
            cls.quotaExhausted ? `quota exhausted (${upstream.status})` : `rate limited (${upstream.status})`,
            cls.resetsAt,
          );
        }
        else if (cls.kind === 'auth_invalid') markCodexInvalid(account, `auth invalid (${upstream.status})`);
        else if (cls.retryable) markCodexTemporaryFailure(account, `temporary upstream failure (${upstream.status})`);
        if (cls.retryable) continue;
        return { ok: false, status: upstream.status, errorBody: text || openAiError(cls.kind), headers: respHeaders, accountLabel: account.label };
      }

      // Stream-consume Responses SSE, collect image data from output_item.done events.
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const images: Array<{ b64_json: string; revised_prompt?: string }> = [];
      let usage: any = null;
      const consume = (force = false) => {
        let sep;
        while ((sep = pending.indexOf('\n\n')) !== -1) {
          const event = pending.slice(0, sep);
          pending = pending.slice(sep + 2);
          handleEvent(event);
        }
        if (force && pending.trim()) { handleEvent(pending); pending = ''; }
      };
      const handleEvent = (event: string) => {
        const lines = event.split(/\r?\n/);
        const dataPayload = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!dataPayload || dataPayload === '[DONE]') return;
        try {
          const evt = JSON.parse(dataPayload);
          if (evt.type === 'response.output_item.done' && evt.item?.type === 'image_generation_call' && evt.item.result) {
            images.push({ b64_json: evt.item.result, revised_prompt: evt.item.revised_prompt });
          } else if (evt.type === 'response.completed') {
            usage = evt.response?.usage || evt.usage || usage;
          }
        } catch {}
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        consume(false);
      }
      pending += decoder.decode();
      consume(true);
      releaseCodexSlot(account);
      markCodexSuccess(account);

      if (!images.length) {
        lastError = 'Codex did not return an image';
        return { ok: false, status: 502, errorBody: openAiError(lastError, 'server_error', 'no_image_returned'), headers: respHeaders, accountLabel: account.label };
      }

      const cost = estimateCost(requestedModel, {}, 'openai_codex');
      const usageEventId = recordUsage({
        userId: user.id, tokenId: token.id, providerAccountId: account.id,
        provider: 'openai_codex', endpoint: `/v1${endpoint}`, model: requestedModel, stream: false,
        statusCode: 200,
        inputTokens: usage?.input_tokens || 0,
        outputTokens: usage?.output_tokens || 0,
        estimatedCostUsd: cost,
        latencyMs: Date.now() - started,
        tokenLabel: token.label, providerAccountLabel: account.label,
      });
      enforceAfterUsage(user, 'openai_codex', token, requestedModel);
      const responseShape = { created: Math.floor(Date.now() / 1000), data: images };
      if (shouldLogBody(user)) logRequestResponse({ usageEventId, userId: user.id, requestBody: body, responseText: JSON.stringify({ images: images.length, usage }) });
      return { ok: true, status: 200, responseShape, headers: respHeaders, accountLabel: account.label, usage };
    } catch (err: any) {
      releaseCodexSlot(account);
      lastError = err?.message || String(err);
      markCodexTemporaryFailure(account, `proxy error: ${lastError.slice(0, 200)}`);
    }
  }
  respHeaders['x-gateway-provider'] = 'openai_codex';
  return { ok: false, status: 503, errorBody: openAiError(`Codex image capacity unavailable: ${lastError}`, 'server_error', 'service_unavailable'), headers: respHeaders };
}

// Synchronous Codex image handler. Thin wrapper around `runCodexImageJob`:
// auth + model/limit guards (unchanged), then translate the worker result to
// the exact reply/status/headers/body this handler has always produced.
async function forwardOpenAiImageViaCodex(req: any, reply: any, endpoint: '/images/generations' | '/images/edits', started: number, parsedBody?: any) {
  // requireProxyToken was already called by the caller; this idempotently
  // re-validates and returns the same context. The reply state is fine.
  const auth2 = await requireProxyToken(req, reply);
  if (!auth2) return;
  const body = (parsedBody ?? req.body) as any;
  const requestedModel = typeof body?.model === 'string' ? body.model : 'gpt-image-2';
  const allowed = isModelAllowedForUser(auth2.user, 'openai_codex', requestedModel);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth2.user, 'openai_codex', auth2.token, requestedModel);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const result = await runCodexImageJob({ user: auth2.user, token: auth2.token, endpoint, body, started });
  for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
  if (result.ok) {
    reply.code(result.status).type('application/json').send(result.responseShape);
    return;
  }
  if (typeof result.errorBody === 'string') {
    reply.code(result.status).type('application/json').send(result.errorBody);
    return;
  }
  reply.code(result.status).send(result.errorBody);
}

async function forwardOpenAiRealtimeClientSecret(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const started = Date.now();
  const requestedModel = normalizeOpenAiRealtimeModel((req.body as any)?.session?.model ?? (req.body as any)?.model);
  if (!OPENAI_REALTIME_MODELS.has(requestedModel)) {
    reply.code(400).send(modelNotAllowedForUserError(`Model ${requestedModel} is not an OpenAI realtime model`));
    return;
  }
  const allowed = isModelAllowedForUser(auth.user, 'openai_codex', requestedModel);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'openai_codex', auth.token, requestedModel);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const body = normalizeRealtimeClientSecretBody(req.body, requestedModel);
  const conversationId = String(req.headers['x-conversation-id'] || req.headers['session_id'] || req.headers['x-client-request-id'] || '');
  const candidates = selectStickyCodexAccounts(`${auth.user.email}:${auth.token.label}:${conversationId || requestedModel}:realtime-client-secret`, [], auth.user.email, requestedModel);
  let lastError = 'No Codex account available for OpenAI realtime';
  for (const account of candidates) {
    if (!acquireCodexSlot(account)) { lastError = 'Codex at concurrency cap'; continue; }
    try {
      const fresh = await ensureFreshCodexAccount(account);
      if (!fresh) { releaseCodexSlot(account); lastError = 'Codex refresh failed'; continue; }
      const upstream = await fetch(`${config.openaiPlatformUpstreamUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${fresh.secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      reply.header('x-gateway-provider', 'openai_codex');
      reply.header('x-gateway-account', account.label);
      const text = await upstream.text().catch(() => '');
      releaseCodexSlot(account);

      if (upstream.status >= 400) {
        lastError = text.slice(0, 500) || String(upstream.status);
        const kind = classifyCodexUpstreamError(upstream.status, text, upstream.headers.get('retry-after'));
        if (kind.kind === 'rate_limit') markCodexBucketRateLimited(fresh, requestedModel, kind.cooldownMs || 60_000, kind.quotaExhausted ? 'quota_exhausted' : 'rate_limit');
        else if (kind.kind === 'auth_invalid') markCodexInvalid(fresh, 'auth_invalid');
        else if (kind.kind === 'temporary') markCodexTemporaryFailure(fresh, 'temporary');
        recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: fresh.id, provider: 'openai_codex', endpoint: '/v1/realtime/client_secrets', model: requestedModel, stream: false, statusCode: upstream.status, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: fresh.label });
        if (kind.retryable && account !== candidates[candidates.length - 1]) continue;
        reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text || openAiError(lastError));
        return;
      }

      markCodexSuccess(fresh);
      const usageEventId = recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: fresh.id, provider: 'openai_codex', endpoint: '/v1/realtime/client_secrets', model: requestedModel, stream: false, statusCode: upstream.status, estimatedCostUsd: 0, latencyMs: Date.now() - started, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: fresh.label });
      enforceAfterUsage(auth.user, 'openai_codex', auth.token, requestedModel);
      if (shouldLogBody(auth.user)) {
        let parsed: any = null;
        try { parsed = JSON.parse(text || '{}'); } catch {}
        logRequestResponse({ usageEventId, userId: auth.user.id, requestBody: { provider: 'openai_codex', endpoint: '/v1/realtime/client_secrets', model: requestedModel, requestedSession: { ...body.session, client_secret: undefined } }, responseText: JSON.stringify({ provider: 'openai_codex', endpoint: '/v1/realtime/client_secrets', model: requestedModel, expires_at: parsed?.expires_at || parsed?.client_secret?.expires_at, realtimeUsageMeteredByGateway: false }) });
      }
      reply.code(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      return;
    } catch (err: any) {
      releaseCodexSlot(account);
      lastError = err?.message || String(err);
      markCodexTemporaryFailure(account, `realtime proxy error: ${lastError.slice(0, 200)}`);
      recordUsage({ userId: auth.user.id, tokenId: auth.token.id, providerAccountId: account.id, provider: 'openai_codex', endpoint: '/v1/realtime/client_secrets', model: requestedModel, stream: false, statusCode: 502, estimatedCostUsd: 0, latencyMs: Date.now() - started, error: lastError, ...compressionFields(req), tokenLabel: auth.token.label, providerAccountLabel: account.label });
    }
  }
  reply.header('x-gateway-provider', 'openai_codex');
  reply.code(503).send(openAiError(`OpenAI realtime capacity unavailable: ${lastError}`, 'server_error', 'service_unavailable'));
}

// ─── Async (poll-based) Codex image jobs ────────────────────────────────
// Slow Codex/ChatGPT-OAuth image generations can exceed Cloudflare's ~100s 524
// timeout. These opt-in routes queue a job row, kick off `runCodexImageJob` in
// the background, and immediately return 202 with a poll URL. Clients poll
// GET /v1/images/jobs/:id until status is completed/failed. The synchronous
// /v1/images/* routes are unchanged.
const STUCK_RUNNING_MS = 10 * 60 * 1000; // running > 10m with no result => failed on read
const IMAGE_JOB_TTL_MS = 60 * 60 * 1000; // rows expire 1h after creation

function imageJobExpireStuckAndPurge(): void {
  const db = getDb();
  const now = Date.now();
  // Lazily fail jobs stuck in 'running' (likely lost to a process restart).
  db.prepare(`
    UPDATE image_jobs
    SET status='failed',
        error_json=?,
        status_code=500,
        updated_at=?
    WHERE status='running' AND updated_at < ?
  `).run(
    JSON.stringify(openAiError('Image job did not complete (worker lost, likely a restart)', 'server_error', 'job_lost')),
    now,
    now - STUCK_RUNNING_MS,
  );
  // Purge expired rows so the base64 payloads don't accumulate.
  db.prepare('DELETE FROM image_jobs WHERE expires_at < ?').run(now);
}

function startImageJobWorker(jobId: string, user: any, token: any, endpoint: '/images/generations' | '/images/edits', body: any): void {
  const started = Date.now();
  const db = getDb();
  db.prepare('UPDATE image_jobs SET status=?, updated_at=? WHERE id=? AND status=?').run('running', Date.now(), jobId, 'queued');
  // Fire-and-forget. The caller does NOT await this; the 202 has already been
  // sent. Any throw is captured and stored as a failed job.
  void (async () => {
    try {
      const result = await runCodexImageJob({ user, token, endpoint, body, started });
      if (result.ok) {
        getDb().prepare('UPDATE image_jobs SET status=?, result_json=?, status_code=?, provider_account_label=?, updated_at=? WHERE id=?')
          .run('completed', JSON.stringify(result.responseShape), result.status, result.accountLabel || null, Date.now(), jobId);
      } else {
        const errBody = typeof result.errorBody === 'string'
          ? (() => { try { return JSON.parse(result.errorBody); } catch { return openAiError(result.errorBody); } })()
          : result.errorBody;
        getDb().prepare('UPDATE image_jobs SET status=?, error_json=?, status_code=?, provider_account_label=?, updated_at=? WHERE id=?')
          .run('failed', JSON.stringify(errBody), result.status, result.accountLabel || null, Date.now(), jobId);
      }
    } catch (err: any) {
      getDb().prepare('UPDATE image_jobs SET status=?, error_json=?, status_code=?, updated_at=? WHERE id=?')
        .run('failed', JSON.stringify(openAiError(err?.message || String(err), 'server_error', 'job_failed')), 500, Date.now(), jobId);
    }
  })();
}

async function enqueueOpenAiImageJob(req: any, reply: any, endpoint: '/images/generations' | '/images/edits') {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  const normalizedReq = normalizeOpenAiImageRequest(req);
  const body = normalizedReq.body as any;
  const requestedModel = typeof body?.model === 'string' ? body.model : 'gpt-image-2';

  if (endpoint === '/images/edits' && normalizedReq.rawMultipart && !body?.image) {
    reply.code(400).send(openAiError('OpenAI image edits multipart request requires at least one image field', 'invalid_request_error', 'missing_image'));
    return;
  }
  // Same up-front guards as the sync Codex path so async can't bypass
  // model-allow or per-user/token limits.
  const allowed = isModelAllowedForUser(auth.user, 'openai_codex', requestedModel);
  if (!allowed.ok) {
    reply.code(400).send(modelNotAllowedForUserError(allowed.message));
    return;
  }
  const limit = checkLooseLimit(auth.user, 'openai_codex', auth.token, requestedModel);
  if (!limit.ok) {
    reply.code(429).send(openAiError(limit.message, 'insufficient_quota', 'user_limit_exceeded'));
    return;
  }

  const jobId = crypto.randomUUID();
  const now = Date.now();
  // Persist the parsed Images-API body (for edits this includes base64 image(s))
  // so the background worker can reconstruct the Responses input independently
  // of the original HTTP request / multipart framing.
  getDb().prepare(`
    INSERT INTO image_jobs (id,user_id,token_id,endpoint,status,request_json,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(jobId, auth.user.id, auth.token.id, endpoint, 'queued', JSON.stringify(body), now, now, now + IMAGE_JOB_TTL_MS);

  // Kick off the worker WITHOUT awaiting, then respond 202 immediately.
  startImageJobWorker(jobId, auth.user, auth.token, endpoint, body);

  reply.header('x-gateway-provider', 'openai_codex');
  reply.header('x-gateway-image-mode', 'codex-responses-async');
  reply.code(202).send({ job_id: jobId, status: 'queued', poll_url: `/v1/images/jobs/${jobId}` });
}

async function getOpenAiImageJob(req: any, reply: any) {
  const auth = await requireProxyToken(req, reply);
  if (!auth) return;
  imageJobExpireStuckAndPurge();
  const jobId = String((req.params as any)?.id || '');
  const row = getDb().prepare('SELECT * FROM image_jobs WHERE id=?').get(jobId) as any;
  reply.header('x-gateway-provider', 'openai_codex');
  reply.header('x-gateway-image-mode', 'codex-responses-async');
  // 404 if not found OR not owned by this token's user (never leak other
  // users' jobs).
  if (!row || row.user_id !== auth.user.id) {
    reply.code(404).send(openAiError('Image job not found', 'invalid_request_error', 'job_not_found'));
    return;
  }
  const out: any = {
    job_id: row.id,
    status: row.status,
    endpoint: row.endpoint,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
  if (row.provider_account_label) out.provider_account_label = row.provider_account_label;
  if (row.status === 'completed' && row.result_json) {
    const result = JSON.parse(row.result_json);
    // Full OpenAI Images shape so clients consume it identically to the sync route.
    out.created = result.created;
    out.data = result.data;
    out.status_code = row.status_code ?? 200;
  } else if (row.status === 'failed') {
    out.status_code = row.status_code ?? 500;
    if (row.error_json) { try { out.error = JSON.parse(row.error_json).error ?? JSON.parse(row.error_json); } catch { out.error = { message: row.error_json }; } }
  }
  reply.code(200).send(out);
}


export function registerOpenAiProxy(app: FastifyInstance) {
  try {
    app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 }, (_req: any, body: Buffer, done: any) => done(null, body));
  } catch (err: any) {
    if (!/already present|already exists|content type parser/i.test(String(err?.message || err))) throw err;
  }
  app.post('/v1/realtime/client_secrets', (req, reply) => forwardOpenAiRealtimeClientSecret(req, reply));
  app.post('/v1/responses', (req, reply) => forwardOpenAiCompatible(req, reply, '/v1/responses'));
  app.post('/v1/chat/completions', (req, reply) => forwardOpenAiCompatible(req, reply, '/v1/chat/completions'));
  app.post('/v1/images/generations', (req, reply) => forwardOpenAiImage(req, reply, '/images/generations'));
  app.post('/v1/images/edits', (req, reply) => forwardOpenAiImage(req, reply, '/images/edits'));
  // Async (poll-based) image jobs — for slow Codex image generations that would
  // otherwise trip Cloudflare's ~100s 524 timeout. Sync routes above unchanged.
  app.post('/v1/images/generations/async', (req, reply) => enqueueOpenAiImageJob(req, reply, '/images/generations'));
  app.post('/v1/images/edits/async', (req, reply) => enqueueOpenAiImageJob(req, reply, '/images/edits'));
  app.get('/v1/images/jobs/:id', (req, reply) => getOpenAiImageJob(req, reply));
}
