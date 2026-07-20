// Kimi/Moonshot pricing. NOTE: the prod Kimi account uses the flat-fee "coding"
// subscription (api.kimi.com/coding/v1), so actual marginal spend is ~$0. These
// rates are the OFFICIAL retail per-token prices (platform.kimi.ai/pricing) and
// are recorded as NOTIONAL / equivalent cost for per-user attribution & usage
// visibility, not actual billed spend. kimi-k2.6: cache-miss input $0.95/1M,
// output $4.00/1M, cache-hit input $0.16/1M. kimi-k2.7-code: cache-miss input
// $0.95/1M, output $4.00/1M, cache-hit input $0.19/1M. kimi-for-coding is
// served by the same k2.6 model so it shares the k2.6 rate.
const KIMI_PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'kimi-k2.6': { input: 0.95 / 1_000_000, output: 4.0 / 1_000_000, cacheRead: 0.16 / 1_000_000 },
  'kimi-for-coding': { input: 0.95 / 1_000_000, output: 4.0 / 1_000_000, cacheRead: 0.16 / 1_000_000 },
  'kimi-k2.7-code': { input: 0.95 / 1_000_000, output: 4.0 / 1_000_000, cacheRead: 0.19 / 1_000_000 },
};
const KIMI_DEFAULT_PRICE = { input: 0.95 / 1_000_000, output: 4.0 / 1_000_000, cacheRead: 0.16 / 1_000_000 };

const PRICES: Record<string, { input: number; output: number; cacheWrite?: number; cacheRead?: number }> = {
  // Fable 5 / Mythos 5 (Mythos-class): $10 in / $50 out per MTok (anthropic.com/news/claude-fable-5-mythos-5).
  // Cache rates follow Anthropic's standard 1.25x write / 0.1x read of input.
  'claude-fable': { input: 10 / 1_000_000, output: 50 / 1_000_000, cacheWrite: 12.5 / 1_000_000, cacheRead: 1.0 / 1_000_000 },
  'claude-opus': { input: 15 / 1_000_000, output: 75 / 1_000_000, cacheWrite: 18.75 / 1_000_000, cacheRead: 1.5 / 1_000_000 },
  'claude-sonnet': { input: 3 / 1_000_000, output: 15 / 1_000_000, cacheWrite: 3.75 / 1_000_000, cacheRead: 0.3 / 1_000_000 },
  'claude-haiku': { input: 0.8 / 1_000_000, output: 4 / 1_000_000, cacheWrite: 1 / 1_000_000, cacheRead: 0.08 / 1_000_000 },
  'openai': { input: 2 / 1_000_000, output: 8 / 1_000_000 },
  'gemini-pro': { input: 1.25 / 1_000_000, output: 10 / 1_000_000 },
  'gemini-3.5-flash': { input: 1.5 / 1_000_000, output: 9 / 1_000_000 },
  'gemini-flash': { input: 0.3 / 1_000_000, output: 2.5 / 1_000_000 },
  'gemini-flash-lite': { input: 0.1 / 1_000_000, output: 0.4 / 1_000_000 },
};

const XAI_TEXT_PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  // xAI Chat API pricing: https://docs.x.ai/developers/models
  // grok-4.5 has cached-input pricing ($0.50/1M); other grok text models are
  // recorded at $0 (no retail table) upstream, so only 4.5 carries cacheRead.
  'grok-4.5': { input: 2.0 / 1_000_000, output: 6.0 / 1_000_000, cacheRead: 0.5 / 1_000_000 },
};

// z.ai GLM retail rates (https://docs.z.ai/guides/overview/pricing). GLM runs on
// the flat-fee Coding Plan in prod, so these are NOTIONAL retail-equivalent for
// usage visibility, not billed spend — same treatment as Kimi/Anthropic pools.
// GLM uses Anthropic-style SEPARATE cache accounting (cache_read_input_tokens is
// its own pool, verified live 2026-07-10). No cacheWrite billed by z.ai.
const GLM_PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'glm-5.2':      { input: 1.4 / 1_000_000, cacheRead: 0.26 / 1_000_000, output: 4.4 / 1_000_000 },
  'glm-5.1':      { input: 1.4 / 1_000_000, cacheRead: 0.26 / 1_000_000, output: 4.4 / 1_000_000 },
  'glm-5':        { input: 1.0 / 1_000_000, cacheRead: 0.20 / 1_000_000, output: 3.2 / 1_000_000 },
  'glm-5-turbo':  { input: 1.2 / 1_000_000, cacheRead: 0.24 / 1_000_000, output: 4.0 / 1_000_000 },
  'glm-4.7':      { input: 0.6 / 1_000_000, cacheRead: 0.11 / 1_000_000, output: 2.2 / 1_000_000 },
  'glm-4.6':      { input: 0.6 / 1_000_000, cacheRead: 0.11 / 1_000_000, output: 2.2 / 1_000_000 },
  'glm-4.5':      { input: 0.6 / 1_000_000, cacheRead: 0.11 / 1_000_000, output: 2.2 / 1_000_000 },
};
const GLM_DEFAULT_PRICE = { input: 0.6 / 1_000_000, cacheRead: 0.11 / 1_000_000, output: 2.2 / 1_000_000 };

// OpenAI Codex retail rates (developers.openai.com/api/docs/models). The pool
// uses ChatGPT Codex subscriptions, so these are NOTIONAL retail-equivalent for
// usage visibility, not billed spend. Codex uses OpenAI-style SUBSET cache
// accounting (cached_tokens ⊆ input_tokens, verified live). cacheRead = 10% of
// input per OpenAI's standard cached-input discount.
const CODEX_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite?: number }> = {
  'gpt-5.6-sol':   { input: 5.0 / 1_000_000, cacheRead: 0.50 / 1_000_000, output: 30.0 / 1_000_000, cacheWrite: 6.25 / 1_000_000 },
  'gpt-5.6-terra': { input: 2.5 / 1_000_000, cacheRead: 0.25 / 1_000_000, output: 15.0 / 1_000_000, cacheWrite: 3.125 / 1_000_000 },
  'gpt-5.6-luna':  { input: 1.0 / 1_000_000, cacheRead: 0.10 / 1_000_000, output: 6.0 / 1_000_000, cacheWrite: 1.25 / 1_000_000 },
  'gpt-5.5':       { input: 5.0 / 1_000_000, cacheRead: 0.50 / 1_000_000, output: 30.0 / 1_000_000 },
  'gpt-5.4':       { input: 2.5 / 1_000_000, cacheRead: 0.25 / 1_000_000, output: 15.0 / 1_000_000 },
  'gpt-5.4-mini':  { input: 0.75 / 1_000_000, cacheRead: 0.075 / 1_000_000, output: 6.0 / 1_000_000 },
};
const CODEX_DEFAULT_PRICE = { input: 5.0 / 1_000_000, cacheRead: 0.50 / 1_000_000, output: 30.0 / 1_000_000 };

const XAI_IMAGE_PRICES: Record<string, number> = {
  'grok-imagine-image': 0.02,
  'grok-imagine-image-quality': 0.05,
};

const XAI_VIDEO_PRICES: Record<string, number> = {
  'grok-imagine-video': 0.050,
  'grok-imagine-video-1.5-preview': 0.080,
};

// xAI published Grok STT/TTS API rates: https://x.ai/news/grok-stt-and-tts-apis
// The audio endpoints do not return cost_in_usd_ticks, so the gateway computes
// deterministic estimates from request characters (TTS) and returned duration (STT).
export const XAI_TTS_USD_PER_1M_CHARS = 15;
export const XAI_STT_USD_PER_HOUR = 0.10;

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export interface TokenRates { input: number; output: number; cacheWrite?: number; cacheRead?: number }

// Single source of truth for per-token retail rates, shared by per-request
// estimation (below) and rollup cache-savings math (src/monitoring/).
// Returns null when we have no per-token pricing for the provider/model
// (callers must treat null as "no savings computable", not "free").
export function getRates(provider: string, model?: string): TokenRates | null {
  const m = (model || '').toLowerCase();
  if (provider === 'kimi') return KIMI_PRICES[m] || KIMI_DEFAULT_PRICE;
  if (provider === 'glm') return GLM_PRICES[m] || GLM_DEFAULT_PRICE;
  if (provider === 'openai_codex') return CODEX_PRICES[m] || CODEX_DEFAULT_PRICE;
  if (provider === 'xai') return XAI_TEXT_PRICES[m] || null; // only priced text models (e.g. grok-4.5)
  if (provider === 'openrouter' || provider === 'gemini') {
    if (m === 'tencent/hy3:free') return null;
    const key = m.includes('gemini-3.5-flash') ? 'gemini-3.5-flash' : m.includes('flash-lite') ? 'gemini-flash-lite' : m.includes('flash') ? 'gemini-flash' : 'gemini-pro';
    return PRICES[key];
  }
  // No per-token retail pricing tables for these: media/audio providers and
  // pools where we deliberately record $0.
  if (provider === 'fusion' || provider === 'fish' || provider === 'deepgram' || provider === 'groq' || provider === 'cerebras' || provider === 'runpod') return null;
  const key = m.includes('fable') || m.includes('mythos') ? 'claude-fable' : m.includes('opus') ? 'claude-opus' : m.includes('haiku') ? 'claude-haiku' : m.includes('claude') || provider === 'anthropic' ? 'claude-sonnet' : 'openai';
  return PRICES[key];
}

// Cache token accounting differs by provider (verified live 2026-07-10):
//  - SUBSET (openai_codex, xai, kimi): cached_tokens are a SUBSET already
//    counted inside input_tokens. Total prompt = input (cacheRead ⊆ input).
//  - SEPARATE (anthropic, glm, and default/legacy providers): cache_read tokens
//    are their OWN pool, NOT part of input_tokens. Total prompt = input +
//    cacheRead + cacheCreation.
// This flag drives cacheSavedUsd and monitoring metrics so we never double-count
// cached subset tokens.
export type CacheSemantics = 'separate' | 'subset';
export function cacheSemantics(provider: string): CacheSemantics {
  return (provider === 'kimi' || provider === 'xai' || provider === 'openai_codex') ? 'subset' : 'separate';
}

export function estimateXaiTtsCost(charCount: number): number {
  return roundUsd(Math.max(0, charCount || 0) * XAI_TTS_USD_PER_1M_CHARS / 1_000_000);
}

export function estimateXaiSttCost(durationSeconds: number): number {
  return roundUsd(Math.max(0, durationSeconds || 0) * XAI_STT_USD_PER_HOUR / 3600);
}

export function estimateXaiMediaCost(model: string | undefined, input: { imageCount?: number; durationSeconds?: number; isEdit?: boolean; inputImageCount?: number }): number {
  const m = (model || '').toLowerCase();
  const imagePrice = XAI_IMAGE_PRICES[m];
  if (imagePrice != null) {
    const outputImages = Math.max(1, Math.floor(input.imageCount || 1));
    const inputImages = input.isEdit ? Math.max(0, Math.floor(input.inputImageCount || 0)) : 0;
    return imagePrice * (outputImages + inputImages);
  }
  const videoPrice = XAI_VIDEO_PRICES[m];
  if (videoPrice != null) return videoPrice * Math.max(0, input.durationSeconds || 0);
  return 0;
}

export function estimateCost(model: string | undefined, usage: { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number }, provider = 'anthropic'): number {
  // Fusion virtual provider — real cost is recorded by individual sub-call events
  if (provider === 'fusion') return 0;
  if (provider === 'groq') return 0;
  if (provider === 'cerebras') return 0;
  if (provider === 'gemini') return 0;
  if (provider === 'kimi') {
    // Notional retail-equivalent cost (flat-fee plan; see KIMI_PRICES note).
    const p = getRates('kimi', model) as TokenRates;
    const cacheRead = usage.cacheReadTokens || 0;
    const billableInput = Math.max(0, (usage.inputTokens || 0) - cacheRead);
    return roundUsd(billableInput * p.input + cacheRead * (p.cacheRead || p.input) + (usage.outputTokens || 0) * p.output);
  }
  if (provider === 'glm') {
    // Notional retail-equivalent (flat-fee Coding Plan; ~$0 actual spend). GLM
    // uses SEPARATE cache accounting: cache_read is its OWN pool, so bill input
    // and cacheRead independently (do NOT subtract read from input).
    const p = getRates('glm', model) as TokenRates;
    return roundUsd(
      (usage.inputTokens || 0) * p.input +
      (usage.cacheReadTokens || 0) * (p.cacheRead ?? p.input) +
      (usage.cacheCreationTokens || 0) * (p.cacheWrite ?? p.input) +
      (usage.outputTokens || 0) * p.output,
    );
  }
  if (provider === 'fish') return 0; // Fish Audio s2.1-pro-free is free/fair-use.
  if (provider === 'deepgram') return 0;
  if (provider === 'xai') {
    // Notional retail-equivalent. xAI uses SUBSET cache accounting: cached_tokens
    // are already inside input_tokens, so split input into billable + cached and
    // price the cached slice at the discounted cacheRead rate.
    const p = getRates('xai', model);
    if (!p) return 0;
    const cacheRead = usage.cacheReadTokens || 0;
    const billableInput = Math.max(0, (usage.inputTokens || 0) - cacheRead);
    return roundUsd(
      billableInput * p.input +
      cacheRead * (p.cacheRead ?? p.input) +
      (usage.outputTokens || 0) * p.output,
    );
  }
  if (provider === 'openai_codex') {
    // Notional retail-equivalent (ChatGPT Codex subscription pool). SUBSET
    // accounting like xAI: cached_tokens ⊆ input_tokens.
    const p = getRates('openai_codex', model) as TokenRates;
    const cacheRead = usage.cacheReadTokens || 0;
    const billableInput = Math.max(0, (usage.inputTokens || 0) - cacheRead);
    return roundUsd(
      billableInput * p.input +
      cacheRead * (p.cacheRead ?? p.input) +
      (usage.cacheCreationTokens || 0) * (p.cacheWrite ?? p.input) +
      (usage.outputTokens || 0) * p.output,
    );
  }
  if (provider === 'runpod') return 0;
  if (provider === 'openrouter') {
    const p = getRates('openrouter', model);
    if (!p) return 0;
    return (usage.inputTokens || 0) * p.input + (usage.outputTokens || 0) * p.output;
  }
  // Anthropic (and any remaining) — SEPARATE accounting: input, cacheRead and
  // cacheCreation are independent pools.
  const p = getRates(provider, model) as TokenRates;
  return (usage.inputTokens || 0) * p.input + (usage.outputTokens || 0) * p.output + (usage.cacheCreationTokens || 0) * (p.cacheWrite || p.input) + (usage.cacheReadTokens || 0) * (p.cacheRead || p.input);
}
