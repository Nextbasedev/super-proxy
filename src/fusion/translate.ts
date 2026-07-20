import { parseProviderModel } from './presets.js';
import type { FusionThinkingConfig, AnthropicThinkingConfig, OpenAiThinkingConfig, GeminiThinkingConfig, XaiThinkingConfig } from './types.js';
import { PROVIDER_ROUTES, type ProviderRoute } from './provider-routes.js';
export { PROVIDER_ROUTES, hasFusionProviderRoute } from './provider-routes.js';
export type { ProviderFormat, ProviderRoute, FusionRouteProvider } from './provider-routes.js';

export function getProviderRoute(providerModel: string): ProviderRoute {
  const [provider] = parseProviderModel(providerModel);
  const route = PROVIDER_ROUTES[provider];
  if (!route) {
    throw new Error(`No route found for provider "${provider}" (from "${providerModel}")`);
  }
  return route;
}

/**
 * Extract messages from the original request body.
 * Returns { systemPrompt, messages } where messages have system role stripped.
 */
function extractMessages(messages: any[]): { systemPrompt: string; messages: any[] } {
  const systemParts: string[] = [];
  const rest: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part?.text === 'string') systemParts.push(part.text);
          else if (typeof part === 'string') systemParts.push(part);
        }
      }
    } else {
      rest.push(msg);
    }
  }
  return { systemPrompt: systemParts.join('\n\n'), messages: rest };
}

// ─── Thinking/reasoning helpers (raw per-provider, no unified mapping) ─────

// xAI model variant lookup table.
const XAI_REASONING_VARIANTS: Record<string, { reasoning: string; nonReasoning: string }> = {
  'grok-4-fast': { reasoning: 'grok-4-fast-reasoning', nonReasoning: 'grok-4-fast-non-reasoning' },
  'grok-4-1-fast': { reasoning: 'grok-4-1-fast-reasoning', nonReasoning: 'grok-4-1-fast-non-reasoning' },
  'grok-4.20-beta-latest': { reasoning: 'grok-4.20-beta-latest-reasoning', nonReasoning: 'grok-4.20-beta-latest-non-reasoning' },
};

/** Inject Anthropic thinking + effort params directly into the request body. */
function applyAnthropicThinking(body: Record<string, any>, config: AnthropicThinkingConfig): void {
  if (config.thinking) {
    body.thinking = config.thinking;
    if (config.thinking.type === 'enabled' && config.thinking.budget_tokens && body.max_tokens <= config.thinking.budget_tokens) {
      body.max_tokens = config.thinking.budget_tokens + 4096;
    }
  }
  if (config.effort) {
    // Anthropic's Messages API rejects a top-level `effort` field
    // ("effort: Extra inputs are not permitted"). Effort must go under
    // `output_config.effort` (gated by the effort-2025-11-24 beta the
    // anthropic proxy already injects). Verified live: top-level 400s,
    // output_config.effort 200s.
    body.output_config = { ...(body.output_config ?? {}), effort: config.effort };
  }
}

/** Inject OpenAI/Codex reasoning effort into the request body. */
function applyOpenAiThinking(body: Record<string, any>, config: OpenAiThinkingConfig): void {
  body.reasoning = { effort: config.effort };
}

/** Swap xAI model to reasoning/non-reasoning variant. */
function applyXaiThinking(model: string, variant: XaiThinkingConfig): string {
  for (const [base, variants] of Object.entries(XAI_REASONING_VARIANTS)) {
    if (model === base || model === variants.reasoning || model === variants.nonReasoning) {
      return variant === 'reasoning' ? variants.reasoning : variants.nonReasoning;
    }
  }
  return model;
}

/** Inject Gemini thinking budget into the request body. */
function applyGeminiThinking(body: Record<string, any>, config: GeminiThinkingConfig): void {
  body.thinking_config = { thinking_budget: config.thinkingBudget };
}

/**
 * Look up the thinking config for a specific provider/model.
 * Returns the config object or undefined if not configured.
 */
function getModelThinking(providerModel: string, thinkingConfig?: FusionThinkingConfig): any | undefined {
  if (!thinkingConfig) return undefined;
  return thinkingConfig[providerModel];
}

/**
 * Translate /chat/completions messages to Anthropic /v1/messages format.
 */
export function translateToAnthropic(
  messages: any[],
  model: string,
  maxTokens: number,
  stream: boolean,
  extraFields?: Record<string, any>,
  thinkingConfig?: FusionThinkingConfig,
  providerModel?: string,
): Record<string, any> {
  const { systemPrompt, messages: filteredMessages } = extractMessages(messages);
  const body: Record<string, any> = {
    model,
    max_tokens: maxTokens,
    messages: filteredMessages,
    stream,
    ...extraFields,
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }
  const modelThinking = providerModel ? getModelThinking(providerModel, thinkingConfig) : undefined;
  if (modelThinking) {
    applyAnthropicThinking(body, modelThinking as AnthropicThinkingConfig);
  }
  return body;
}

/**
 * Convert a /chat/completions message to an OpenAI Responses API input item.
 */
function messageToResponsesInput(msg: any): any {
  const content = typeof msg.content === 'string' ? msg.content : (
    Array.isArray(msg.content)
      ? msg.content.map((p: any) => (typeof p === 'string' ? p : (p?.text || ''))).join('')
      : String(msg.content ?? '')
  );
  if (msg.role === 'assistant') {
    return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] };
  }
  // user role
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] };
}

/**
 * Translate /chat/completions messages to OpenAI Codex /v1/responses format.
 */
export function translateToCodex(
  messages: any[],
  model: string,
  maxTokens: number,
  stream: boolean,
  extraFields?: Record<string, any>,
  thinkingConfig?: FusionThinkingConfig,
  providerModel?: string,
): Record<string, any> {
  const { systemPrompt, messages: filteredMessages } = extractMessages(messages);
  const input = filteredMessages.map(messageToResponsesInput);
  const body: Record<string, any> = {
    model,
    input,
    store: false,
    stream,
    max_output_tokens: maxTokens,
    ...extraFields,
  };
  if (systemPrompt) {
    body.instructions = systemPrompt;
  }
  const modelThinking = providerModel ? getModelThinking(providerModel, thinkingConfig) : undefined;
  if (modelThinking) {
    applyOpenAiThinking(body, modelThinking as OpenAiThinkingConfig);
  }
  return body;
}

/**
 * Translate /chat/completions messages to OpenAI-compat format.
 * This is a pass-through — messages are forwarded as-is.
 */
export function translateToOpenAiCompat(
  messages: any[],
  model: string,
  maxTokens: number,
  stream: boolean,
  extraFields?: Record<string, any>,
  thinkingConfig?: FusionThinkingConfig,
  provider?: string,
  providerModel?: string,
): Record<string, any> {
  let resolvedModel = model;
  const modelThinking = providerModel ? getModelThinking(providerModel, thinkingConfig) : undefined;
  if (provider === 'xai' && modelThinking) {
    resolvedModel = applyXaiThinking(model, modelThinking as XaiThinkingConfig);
  }
  const body: Record<string, any> = {
    model: resolvedModel,
    messages,
    max_tokens: maxTokens,
    stream,
    ...extraFields,
  };
  if (provider === 'gemini' && modelThinking) {
    applyGeminiThinking(body, modelThinking as GeminiThinkingConfig);
  }
  return body;
}

/**
 * Translate request to the appropriate format for a given provider/model.
 * Returns the translated request body.
 */
export function translateRequest(
  providerModel: string,
  messages: any[],
  maxTokens: number,
  stream: boolean,
  extraFields?: Record<string, any>,
  thinkingConfig?: FusionThinkingConfig,
): Record<string, any> {
  const [provider, model] = parseProviderModel(providerModel);
  const route = PROVIDER_ROUTES[provider];
  if (!route) {
    throw new Error(`Unknown provider: "${provider}"`);
  }
  switch (route.format) {
    case 'anthropic':
      return translateToAnthropic(messages, model, maxTokens, stream, extraFields, thinkingConfig, providerModel);
    case 'openai_codex':
      return translateToCodex(messages, model, maxTokens, stream, extraFields, thinkingConfig, providerModel);
    case 'openai_compat':
      return translateToOpenAiCompat(messages, model, maxTokens, stream, extraFields, thinkingConfig, provider, providerModel);
    case 'xai_responses': {
      const modelThinking = getModelThinking(providerModel, thinkingConfig);
      const resolvedModel = modelThinking ? applyXaiThinking(model, modelThinking as XaiThinkingConfig) : model;
      return translateToCodex(messages, resolvedModel, maxTokens, stream, extraFields);
    }
    default:
      throw new Error(`Unhandled format for provider "${provider}"`);
  }
}
