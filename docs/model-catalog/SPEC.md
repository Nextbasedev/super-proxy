# NBMG General Model Catalog — Implementation Spec

## Goal

Make model discovery and validation derive from one canonical registry so adding a model once updates provider validation, Fusion discovery, and `GET /v1/models` without conflating model existence, direct runtime support, or Fusion routability.

## Public contract

- Preserve authenticated `GET /v1/models` and its OpenAI-compatible `{ object: "list", data: [...] }` envelope.
- Preserve each provider's raw callable model ID in `id`; use unique `${provider}/${id}` in `catalog_id`.
- Preserve backward-compatible flat primary fields: `endpoint`, `api`, `streaming`, and `non_streaming`.
- Add typed `interfaces[]` for the complete operation map. The flat fields must be derived from `interfaces[0]`, never maintained independently.
- Include `input_modalities`, `output_modalities`, `capabilities`, `direct_runtime_support`, optional `runtime_model`, derived `fusion_routable`, and optional limits such as `max_reference_images`.
- Filter canonical entries with the same `isModelAllowedForUser()` policy used by proxy requests.
- Do not hide models because accounts are temporarily cooling down; catalog membership is stable configuration, not transient health.
- Do not dynamically trust upstream provider `/models` responses.

## Separate support dimensions

1. **Catalog existence** means an exact `${provider}/${model}` entry exists.
2. **Direct runtime support** means the requested ID is forwarded as-is. `direct_runtime_support: false` requires an explicit `runtime_model` fallback.
3. **Fusion routability** requires an exact chat-capable catalog entry and a provider route implemented in the Fusion dispatcher.

These dimensions must not be inferred from one another. In particular, the catalog may describe GLM and Runpod while Fusion must not advertise or accept them until its dispatcher implements their routes.

## Canonical derivations

The registry under `src/providers/model-catalog.ts` derives:

- `KNOWN_MODELS_BY_PROVIDER`
- `KNOWN_PROVIDERS`
- `isKnownProvider()` / `isKnownModel()` / exact catalog lookup
- provider-specific known model sets, including capability subsets for Gemini and xAI
- the Cerebras direct-runtime subset
- `/v1/models` canonical entries

Fusion's routable subset additionally derives from `src/fusion/provider-routes.ts`, which is the same route table used by request translation and dispatch.

## Interface requirements

Every claimed capability must have a matching typed interface. Required multi-operation entries are:

- OpenAI and OpenAI/Codex images: generation and edit
- xAI images: generation and edit
- `grok-imagine-video`: generation/reference generation, edit, and extend
- `grok-imagine-video-1.5-preview`: generation only
- Kimi: OpenAI-compatible chat and Anthropic-compatible messages
- Groq Whisper: transcription and translation

## Cerebras compatibility

- Preserve the direct runtime pool exactly as `{gpt-oss-120b, zai-glm-4.7}`.
- Catalog aliases `qwen-3-235b-a22b-instruct-2507` and `llama3.1-8b` remain callable through the historical fallback and must expose `direct_runtime_support: false` plus `runtime_model: gpt-oss-120b`.
- Catalog derivation must never widen the direct runtime pool.

## Fusion discovery and validation

- Exact provider/model validation rejects fabricated IDs, non-chat models, and providers absent from the Fusion dispatcher.
- `/api/me/fusion-available-models` returns only exact Fusion-routable catalog entries allowed by current user policy.
- `/v1/models` filters each built-in Fusion alias through Fusion alias policy and verifies every panel and synthesizer model is exact, routable, and allowed for the current user.
- A saved preset is visible only to its owner and only when its alias, panel, and synthesizer all pass those checks.

## Compatibility and scope

- Existing proxy routes and callable model names remain unchanged.
- Existing exported `KNOWN_*` symbols remain available.
- Pricing remains in `proxy/cost.ts`; pricing is not inferred by the catalog.
- No database migration.
- No rebase, push, merge, deploy, or production change in this repair task.

## Required verification

1. Catalog invariants, interface coverage, flat-field derivation, unique IDs, and Cerebras runtime subset tests.
2. Exact Fusion validation and dispatcher-route tests, including xAI Responses translation.
3. `/v1/models` auth, policy filtering, Fusion alias/preset isolation, raw ID, envelope, and metadata tests.
4. `/api/me/fusion-available-models` exact routability and current-user access tests.
5. Model-access and affected provider tests.
6. TypeScript build, full test suite, and `git diff --check`.
7. Signed local commit only; no push or deploy.
