import { getDb } from '../db/index.js';

export type UsageUnit = 'tokens' | 'seconds' | 'chars' | 'images' | 'videos';
export type BillingMode = 'metered' | 'flat_fee' | 'self_hosted' | 'free_tier';
export type RetryReason = 'rate_limited' | 'account_rotation' | 'stale_reasoning' | 'upstream_error';

// How each provider is actually billed. Flat-fee providers record NOTIONAL
// retail-equivalent cost (value absorbed by the subscription), not real spend.
// See docs/MONITORING-SYSTEM.md §11.3.
const BILLING_MODE: Record<string, BillingMode> = {
  anthropic: 'flat_fee', // Claude Code subscription accounts
  openai_codex: 'flat_fee', // ChatGPT-plan pool accounts
  kimi: 'flat_fee', // Kimi coding subscription
  glm: 'flat_fee', // z.ai GLM Coding Plan
  xai: 'flat_fee', // subscription accounts
  runpod: 'self_hosted', // pod-hour cost, not per-token
  fish: 'free_tier',
  // metered (real $): gemini, openrouter, groq, cerebras, deepgram, openai (API), serper
};

export function billingModeFor(provider: string): BillingMode {
  return BILLING_MODE[provider] || 'metered';
}

function intOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function recordUsage(input: {
  userId: number;
  tokenId: number;
  providerAccountId?: number;
  provider: string;
  endpoint: string;
  model?: string;
  stream?: boolean;
  statusCode?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  error?: string;
  tokenLabel?: string;
  providerAccountLabel?: string;
  // Headroom compression fields
  tokensBeforeCompression?: number;
  tokensSavedCompression?: number;
  compressionMs?: number;
  compressionStatus?: string;
  // Monitoring instrumentation fields (2026070901)
  reasoningTokens?: number;
  ttftMs?: number;
  retryCount?: number;
  retryReason?: RetryReason | string;
  unit?: UsageUnit;
  billingMode?: BillingMode;
}): number {
  const billingMode = input.billingMode || billingModeFor(input.provider);
  const info = getDb().prepare(`
    INSERT INTO usage_events (user_id,token_id,provider_account_id,provider,endpoint,model,stream,status_code,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,estimated_cost_usd,latency_ms,error,token_label,provider_account_label,tokens_before_compression,tokens_saved_compression,compression_ms,compression_status,reasoning_tokens,ttft_ms,retry_count,retry_reason,unit,billing_mode)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(input.userId, input.tokenId, input.providerAccountId || null, input.provider, input.endpoint, input.model || null, input.stream ? 1 : 0, input.statusCode || null, input.inputTokens || 0, input.outputTokens || 0, input.cacheCreationTokens || 0, input.cacheReadTokens || 0, input.estimatedCostUsd || 0, input.latencyMs || null, input.error || null, input.tokenLabel || null, input.providerAccountLabel || null, input.tokensBeforeCompression || null, input.tokensSavedCompression || null, input.compressionMs || null, input.compressionStatus || null, input.reasoningTokens != null ? intOrNull(input.reasoningTokens) : null, input.ttftMs != null ? intOrNull(input.ttftMs) : null, input.retryCount ? intOrNull(input.retryCount) : null, input.retryCount ? (input.retryReason || null) : null, input.unit || null, billingMode);
  return Number(info.lastInsertRowid);
}
