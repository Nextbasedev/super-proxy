export type ProviderFormat = 'anthropic' | 'openai_codex' | 'openai_compat' | 'xai_responses';

/** A Fusion sub-call route that is implemented by the gateway. */
export interface ProviderRoute {
  url: string;
  format: ProviderFormat;
}

/**
 * Provider prefixes Fusion can execute. This is intentionally narrower than
 * the canonical chat catalog: a chat-capable model is not Fusion-routable
 * until its request translation and internal route are implemented here.
 */
const ROUTES = {
  anthropic: { url: '/v1/messages', format: 'anthropic' },
  openai_codex: { url: '/v1/responses', format: 'openai_codex' },
  openai: { url: '/v1/chat/completions', format: 'openai_compat' },
  gemini: { url: '/v1/gemini/chat/completions', format: 'openai_compat' },
  groq: { url: '/v1/groq/chat/completions', format: 'openai_compat' },
  cerebras: { url: '/v1/cerebras/chat/completions', format: 'openai_compat' },
  kimi: { url: '/v1/kimi/chat/completions', format: 'openai_compat' },
  openrouter: { url: '/v1/openrouter/chat/completions', format: 'openai_compat' },
  xai: { url: '/v1/xai/responses', format: 'xai_responses' },
} as const satisfies Record<string, ProviderRoute>;

export const PROVIDER_ROUTES: Readonly<Record<string, ProviderRoute>> = ROUTES;

export type FusionRouteProvider = keyof typeof ROUTES;

export function hasFusionProviderRoute(provider: string): provider is FusionRouteProvider {
  return Object.hasOwn(PROVIDER_ROUTES, provider);
}
