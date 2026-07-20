import { cacheSemantics } from '../proxy/cost.js';

/**
 * Provider-aware token accounting for monitoring metrics.
 *
 * SEPARATE providers (Anthropic/GLM): cache_read tokens are an extra prompt
 * pool, separate from input_tokens.
 * SUBSET providers (Kimi/xAI/OpenAI Codex): cache_read tokens are already
 * included inside input_tokens and must not be added again.
 */
export function cacheHitDenominator(provider: string, inputTokens: number, cacheReadTokens: number): number {
  const input = Math.max(0, Number(inputTokens) || 0);
  const cacheRead = Math.max(0, Number(cacheReadTokens) || 0);
  return cacheSemantics(provider) === 'separate' ? input + cacheRead : input;
}

export function tokenWeightedCacheHitRate(provider: string, cacheReadTokens: number, inputTokens: number): number | null {
  const cacheRead = Math.max(0, Number(cacheReadTokens) || 0);
  const denom = cacheHitDenominator(provider, inputTokens, cacheRead);
  if (!denom) return null;
  return Math.round((cacheRead / denom) * 10_000) / 10_000;
}

export function promptTokensForCacheability(provider: string, inputTokens: number, cacheReadTokens: number): number {
  return cacheHitDenominator(provider, inputTokens, cacheReadTokens);
}

export function totalTokens(provider: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number): number {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const cacheRead = Math.max(0, Number(cacheReadTokens) || 0);
  const cacheCreation = Math.max(0, Number(cacheCreationTokens) || 0);
  const extraCacheRead = cacheSemantics(provider) === 'separate' ? cacheRead : 0;
  return input + output + extraCacheRead + cacheCreation;
}
