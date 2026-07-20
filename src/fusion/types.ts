export type FusionMode = 'synthesize' | 'compare';

/**
 * Anthropic thinking config shape (two independent controls).
 */
export interface AnthropicThinkingConfig {
  thinking?: { type: 'adaptive' | 'enabled' | 'disabled'; budget_tokens?: number };
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * OpenAI/Codex reasoning config shape.
 */
export interface OpenAiThinkingConfig {
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * Gemini thinking config shape.
 */
export interface GeminiThinkingConfig {
  thinkingBudget: number;
}

/** xAI thinking = model variant selection */
export type XaiThinkingConfig = 'reasoning' | 'non-reasoning';

/** Union of all provider thinking config shapes */
export type ModelThinkingConfig = AnthropicThinkingConfig | OpenAiThinkingConfig | GeminiThinkingConfig | XaiThinkingConfig;

/**
 * Per-model thinking/reasoning configuration.
 * Each key is a full `provider/model` string (e.g. "anthropic/claude-opus-4-8").
 * The value shape depends on the provider.
 */
export type FusionThinkingConfig = Record<string, ModelThinkingConfig>;

export interface FusionConfig {
  mode?: FusionMode;
  panel: string[]; // provider-prefixed model strings e.g. "anthropic/claude-sonnet-4-5-20250929"
  synthesizer: string; // provider-prefixed model string
  panel_max_tokens?: number;
  synthesizer_max_tokens?: number;
  panel_timeout_ms?: number;
  thinking?: FusionThinkingConfig; // raw per-provider thinking/reasoning config
}

export interface FusionPreset {
  name: string;
  panel: string[];
  synthesizer: string;
  panel_max_tokens: number;
  synthesizer_max_tokens: number;
  panel_timeout_ms: number;
  mode: FusionMode;
  thinking?: FusionThinkingConfig;
}

export interface PanelResult {
  model: string; // provider-prefixed
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface PanelFailure {
  model: string; // provider-prefixed
  error: string;
  statusCode?: number;
}

export interface FusionPanelMetadata {
  models: string[];
  succeeded: number;
  failed: number;
  failed_details: PanelFailure[];
  latency_ms: number;
}

export interface FusionSynthesizerMetadata {
  model: string;
  latency_ms?: number;
  skipped?: boolean;
  succeeded?: boolean;
}

export interface FusionMetadata {
  mode: FusionMode;
  panel: FusionPanelMetadata;
  synthesizer?: FusionSynthesizerMetadata;
  total_latency_ms: number;
}

export interface FusionRequestBody {
  model: string;
  messages: any[];
  stream?: boolean;
  fusion?: Partial<FusionConfig> & { mode?: FusionMode; thinking?: FusionThinkingConfig };
  max_tokens?: number;
  temperature?: number;
  [key: string]: any;
}
