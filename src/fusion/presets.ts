import type { FusionConfig, FusionPreset, FusionThinkingConfig } from './types.js';
import { getDb } from '../db/index.js';
import { MODEL_CATALOG, findCatalogModel, type ModelCatalogEntry } from '../providers/model-catalog.js';
import { hasFusionProviderRoute } from './provider-routes.js';

export const DEFAULT_PANEL_MAX_TOKENS = 4096;
export const DEFAULT_SYNTHESIZER_MAX_TOKENS = 8192;
export const DEFAULT_PANEL_TIMEOUT_MS = 120_000;

const BUILT_IN_PRESETS: Record<string, FusionPreset> = {
  max: {
    name: 'max',
    panel: [
      'anthropic/claude-opus-4-8',
      'openai_codex/gpt-5.5',
      'gemini/gemini-3.5-flash',
    ],
    synthesizer: 'anthropic/claude-opus-4-8',
    panel_max_tokens: DEFAULT_PANEL_MAX_TOKENS,
    synthesizer_max_tokens: DEFAULT_SYNTHESIZER_MAX_TOKENS,
    panel_timeout_ms: DEFAULT_PANEL_TIMEOUT_MS,
    mode: 'synthesize',
    thinking: {
      'anthropic/claude-opus-4-8': { thinking: { type: 'adaptive' }, effort: 'max' },
      'openai_codex/gpt-5.5': { effort: 'xhigh' },
    },
  },
  quality: {
    name: 'quality',
    panel: [
      'anthropic/claude-opus-4-8',
      'openai_codex/gpt-5.5',
      'gemini/gemini-3.5-flash',
    ],
    synthesizer: 'anthropic/claude-opus-4-8',
    panel_max_tokens: DEFAULT_PANEL_MAX_TOKENS,
    synthesizer_max_tokens: DEFAULT_SYNTHESIZER_MAX_TOKENS,
    panel_timeout_ms: DEFAULT_PANEL_TIMEOUT_MS,
    mode: 'synthesize',
    thinking: {
      'anthropic/claude-opus-4-8': { thinking: { type: 'adaptive' }, effort: 'xhigh' },
      'openai_codex/gpt-5.5': { effort: 'high' },
    },
  },
  budget: {
    name: 'budget',
    panel: [
      'anthropic/claude-sonnet-4-5-20250929',
      'openai_codex/gpt-5.4',
      'gemini/gemini-3.5-flash',
    ],
    synthesizer: 'anthropic/claude-sonnet-4-5-20250929',
    panel_max_tokens: DEFAULT_PANEL_MAX_TOKENS,
    synthesizer_max_tokens: DEFAULT_SYNTHESIZER_MAX_TOKENS,
    panel_timeout_ms: DEFAULT_PANEL_TIMEOUT_MS,
    mode: 'synthesize',
    thinking: {
      'anthropic/claude-sonnet-4-5-20250929': { effort: 'medium' },
      'openai_codex/gpt-5.4': { effort: 'medium' },
    },
  },
};

// Reserved preset names that users cannot use for custom presets
export const RESERVED_PRESET_NAMES = new Set(['max', 'quality', 'budget', 'custom']);

// Provider prefixes with at least one exact catalog model that the Fusion
// dispatcher can execute.
export const KNOWN_PROVIDER_PREFIXES = new Set<string>(
  MODEL_CATALOG
    .filter(isFusionRoutableCatalogEntry)
    .map((entry) => entry.provider),
);

/** Fusion eligibility is separate from catalog existence and direct runtime support. */
export function isFusionRoutableCatalogEntry(entry: ModelCatalogEntry): boolean {
  return entry.capabilities.includes('chat') && hasFusionProviderRoute(entry.provider);
}

/**
 * Validate a provider-prefixed model string (e.g. "anthropic/claude-sonnet-...")
 */
export function validateProviderModel(providerModel: string): { ok: true } | { ok: false; message: string } {
  const slashIdx = providerModel.indexOf('/');
  if (slashIdx <= 0 || slashIdx === providerModel.length - 1) {
    return { ok: false, message: `Invalid provider/model format: "${providerModel}". Expected "provider/model-name".` };
  }
  const provider = providerModel.slice(0, slashIdx);
  const model = providerModel.slice(slashIdx + 1);
  const catalogEntry = findCatalogModel(provider, model);
  if (!catalogEntry) {
    return { ok: false, message: `Unknown canonical model "${providerModel}".` };
  }
  if (!catalogEntry.capabilities.includes('chat')) {
    return { ok: false, message: `Model "${providerModel}" is not chat-capable and cannot be used by Fusion.` };
  }
  if (!hasFusionProviderRoute(provider)) {
    return { ok: false, message: `Provider "${provider}" is not supported by Fusion routing.` };
  }
  return { ok: true };
}

/**
 * Validate a FusionConfig inline body
 */
export function validateFusionConfig(config: Partial<FusionConfig>): { ok: true } | { ok: false; message: string } {
  if (!Array.isArray(config.panel) || config.panel.length === 0) {
    return { ok: false, message: 'fusion.panel must be a non-empty array of provider-prefixed model strings.' };
  }
  if (config.panel.length > 8) {
    return { ok: false, message: 'fusion.panel can have at most 8 models.' };
  }
  for (const m of config.panel) {
    const v = validateProviderModel(m);
    if (!v.ok) return v;
  }
  if (!config.synthesizer) {
    return { ok: false, message: 'fusion.synthesizer is required.' };
  }
  const sv = validateProviderModel(config.synthesizer);
  if (!sv.ok) return sv;
  return { ok: true };
}

/**
 * Resolve a model alias like "fusion", "fusion/quality", "fusion/budget", "fusion/custom"
 * to a FusionPreset.
 *
 * - "fusion" or "fusion/quality" → quality preset
 * - "fusion/budget" → budget preset
 * - "fusion/custom" → requires inline fusion body (handled by caller)
 * - Anything else → null (unknown)
 *
 * Phase 1: only built-in presets + inline custom. No DB lookup.
 */
export function resolveBuiltInPreset(modelAlias: string): FusionPreset | null {
  if (modelAlias === 'fusion' || modelAlias === 'fusion/quality') {
    return BUILT_IN_PRESETS.quality;
  }
  if (modelAlias === 'fusion/max') {
    return BUILT_IN_PRESETS.max;
  }
  if (modelAlias === 'fusion/budget') {
    return BUILT_IN_PRESETS.budget;
  }
  // fusion/custom and everything else returns null — handled by caller
  return null;
}

/**
 * Merge inline fusion body config over a preset's defaults.
 * The inline body always wins for any fields it specifies.
 */
export function mergePresetWithInline(preset: FusionPreset, inline: Partial<FusionConfig>): FusionPreset {
  return {
    ...preset,
    mode: inline.mode ?? preset.mode,
    panel: Array.isArray(inline.panel) && inline.panel.length > 0 ? inline.panel : preset.panel,
    synthesizer: inline.synthesizer ?? preset.synthesizer,
    panel_max_tokens: inline.panel_max_tokens ?? preset.panel_max_tokens,
    synthesizer_max_tokens: inline.synthesizer_max_tokens ?? preset.synthesizer_max_tokens,
    panel_timeout_ms: inline.panel_timeout_ms ?? preset.panel_timeout_ms,
    thinking: inline.thinking ?? preset.thinking,
  };
}

/**
 * Look up a user's custom preset by (user_id, name).
 * Returns a FusionPreset on success or null if not found.
 */
export function resolveUserPreset(userId: number, presetName: string): FusionPreset | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT name, panel_models_json, synthesizer_model, panel_max_tokens, synthesizer_max_tokens, panel_timeout_ms, thinking_overrides_json FROM fusion_presets WHERE user_id = ? AND name = ?',
  ).get(userId, presetName) as {
    name: string;
    panel_models_json: string;
    synthesizer_model: string;
    panel_max_tokens: number;
    synthesizer_max_tokens: number;
    panel_timeout_ms: number;
    thinking_overrides_json: string | null;
  } | undefined;

  if (!row) return null;

  let panel: string[];
  try {
    panel = JSON.parse(row.panel_models_json);
  } catch {
    return null;
  }
  if (!Array.isArray(panel) || !panel.every((model) => typeof model === 'string')) return null;

  return {
    name: row.name,
    panel,
    synthesizer: row.synthesizer_model,
    panel_max_tokens: row.panel_max_tokens ?? 4096,
    synthesizer_max_tokens: row.synthesizer_max_tokens ?? 8192,
    panel_timeout_ms: row.panel_timeout_ms ?? 120_000,
    mode: 'synthesize',
    thinking: row.thinking_overrides_json ? (() => { try { return JSON.parse(row.thinking_overrides_json) as FusionThinkingConfig; } catch { return undefined; } })() : undefined,
  };
}

/**
 * Parse the provider prefix from a "provider/model" string.
 * Returns [provider, model] or throws if invalid.
 */
export function parseProviderModel(providerModel: string): [string, string] {
  const slashIdx = providerModel.indexOf('/');
  if (slashIdx <= 0 || slashIdx === providerModel.length - 1) {
    throw new Error(`Invalid provider/model: "${providerModel}"`);
  }
  return [providerModel.slice(0, slashIdx), providerModel.slice(slashIdx + 1)];
}
