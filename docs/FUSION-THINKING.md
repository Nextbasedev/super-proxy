# Fusion Thinking/Reasoning — Research & Design (v2)

## Problem

Fusion panel and synthesizer calls should be able to use thinking/reasoning when the underlying model supports it. Each provider has its own thinking API with different parameters and levels. Rather than hiding this behind a lossy unified abstraction, we expose the raw per-provider values directly.

---

## Provider Thinking APIs (as of June 2026)

### Anthropic — TWO independent parameters

**1. `thinking` parameter** — controls whether extended thinking is enabled:

| Value | Models | Description |
|---|---|---|
| `{type: "adaptive"}` | Opus 4.8, 4.7, 4.6, Sonnet 4.6, Fable 5, Mythos 5 | Model decides when/how much to think. Recommended for all. |
| `{type: "enabled", budget_tokens: N}` | Opus 4.6, Sonnet 4.6 only | Manual budget. **Deprecated.** Rejected on Opus 4.8/4.7/Fable/Mythos (400 error). |
| `{type: "disabled"}` | Opus 4.6, Sonnet 4.6 only | Explicitly disable. Rejected on Fable/Mythos. |
| *(omit)* | All | No extended thinking. Opus 4.8/4.7 won't think unless you set `{type: "adaptive"}`. |

**2. `effort` parameter** — controls how eagerly Claude spends tokens (text + tools + thinking):

| Level | Models | Description |
|---|---|---|
| `low` | All | Most efficient, fastest. May skip thinking on simple problems. |
| `medium` | All | Balanced speed/quality. Good for agentic tasks. |
| `high` | All | **Default** (same as omitting). Deep reasoning. |
| `xhigh` | Opus 4.8, 4.7, Fable 5, Mythos 5 | Extended capability for long-horizon coding/agentic work. |
| `max` | All | Absolute maximum capability. No constraints on token spending. |

`effort` and `thinking` are independent. You can set `effort: "xhigh"` without enabling thinking (faster but still deeper reasoning), or set `thinking: {type: "adaptive"}` with `effort: "low"` (thinking enabled but kept brief).

### OpenAI/Codex — `reasoning` parameter

```json
{"reasoning": {"effort": "medium"}}
```

| Level | Description |
|---|---|
| `none` | No reasoning tokens. Fastest. |
| `minimal` | Barely any reasoning. |
| `low` | Efficient reasoning. |
| `medium` | Default for GPT-5.5. Balanced. |
| `high` | Deep reasoning for complex tasks. |
| `xhigh` | Deepest reasoning. Async/agentic workloads. |

### xAI (Grok) — model variant selection

No parameter. Separate model variants:
- `grok-4-fast` → `grok-4-fast-reasoning` / `grok-4-fast-non-reasoning`
- `grok-4-1-fast` → `grok-4-1-fast-reasoning` / `grok-4-1-fast-non-reasoning`
- `grok-4.20-beta-latest` → `grok-4.20-beta-latest-reasoning` / `grok-4.20-beta-latest-non-reasoning`

### Gemini — `thinkingConfig`

Native API: `thinkingConfig: {thinkingBudget: N}` (token budget).
Through OpenAI-compat: varies. Built into Pro models, configurable on Flash.

### Groq / Cerebras / Kimi / Runpod

No thinking/reasoning support.

---

## Design: Raw Per-Provider Thinking (v2)

### What changed from v1

v1 had a unified `thinking` field (`none`/`low`/`medium`/`high`) that mapped to provider values. This was a **leaky abstraction** — `"high"` meant completely different things per provider, and Anthropic's `effort` levels didn't even map cleanly to 4 options (they have 5 levels plus a separate `thinking` param).

v2 drops the unified field entirely. The only thinking config is raw per-provider:

```jsonc
{
  "model": "fusion/quality",
  "messages": [...],
  "fusion": {
    "thinking": {
      "anthropic": {
        "thinking": {"type": "adaptive"},
        "effort": "xhigh"
      },
      "openai_codex": {
        "effort": "high"
      },
      "xai": "reasoning",
      "gemini": {
        "thinkingBudget": 8192
      }
    }
  }
}
```

Each key is a provider name. The value is the raw config that gets injected into that provider's request. Providers not listed get no thinking params (provider defaults apply).

### Provider schema

```typescript
interface FusionThinkingConfig {
  anthropic?: {
    thinking?: { type: 'adaptive' | 'enabled' | 'disabled'; budget_tokens?: number };
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  openai_codex?: {
    effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
  xai?: 'reasoning' | 'non-reasoning';
  gemini?: {
    thinkingBudget: number;
  };
}
```

### Preset defaults

Built-in presets ship with sensible thinking configs:

**`fusion/quality`** (Opus 4.8 + GPT-5.5 + Gemini 3.1 Pro):
```json
{
  "anthropic": {"thinking": {"type": "adaptive"}, "effort": "high"},
  "openai_codex": {"effort": "high"}
}
```

**`fusion/budget`** (Sonnet + GPT-5.4 + Gemini 3.5 Flash):
```json
{
  "anthropic": {"effort": "medium"},
  "openai_codex": {"effort": "low"}
}
```

### Dashboard UI

The preset form shows a "Thinking / Reasoning" section with provider-specific controls:

- **Anthropic**: thinking type dropdown (Default / Adaptive / Enabled + budget / Disabled) + effort dropdown (Default / low / medium / high / xhigh / max)
- **OpenAI/Codex**: effort dropdown (Default / none / minimal / low / medium / high / xhigh)
- **xAI**: variant dropdown (Default / Reasoning / Non-reasoning)
- **Gemini**: thinkingBudget number input (empty = default)

Only shows providers that are in the panel or synthesizer. "Default" = omit the param, let the provider use its own default.

### Storage

Stored as `thinking_overrides_json TEXT` column in `fusion_presets`. JSON object matching the schema above. NULL = no thinking config.

The old `thinking_level` column (unified level) is kept for backward compat but ignored by the code. New presets won't write to it.

---

## Implementation Changes from v1

1. **types.ts**: Remove `ThinkingLevel`. Replace with `FusionThinkingConfig`. Update `FusionConfig`, `FusionPreset`, `FusionRequestBody`.
2. **presets.ts**: Remove `THINKING_LEVELS`. Built-in presets use `FusionThinkingConfig` objects. Remove unified thinking from merge logic.
3. **translate.ts**: Remove unified mapping functions. Each provider reads its own key from the thinking config directly.
4. **fusion.ts**: Pass `FusionThinkingConfig` to translate calls.
5. **self-api.ts**: Update zod validation to match new schema. Remove unified `thinking` field from CRUD.
6. **console.js**: Replace unified dropdown + advanced section with a single per-provider thinking section. Remove `FUSION_THINKING_LEVELS`.
7. **Docs**: Update ROUTING-CONFIG.md, SKILL.md with new API shape.
