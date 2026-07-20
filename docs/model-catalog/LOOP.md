# Model Catalog Build Loop

- [x] Inventory all hardcoded model and capability sets.
- [x] Add canonical typed catalog and derivation helpers.
- [x] Preserve existing `known-models.ts` exports through derived data.
- [x] Convert provider-specific duplicate sets to catalog-derived subsets.
- [x] Preserve flat primary fields while deriving them from `interfaces[0]`.
- [x] Add complete capability-specific interface maps.
- [x] Separate exact catalog existence, direct runtime support, and Fusion routability.
- [x] Derive Fusion eligibility from the dispatcher route table and reject fake/unroutable IDs.
- [x] Preserve the exact Cerebras direct runtime set and document aliases.
- [x] Expand authenticated `/v1/models` with access-aware catalog entries.
- [x] Filter Fusion aliases/presets by alias, panel, synthesizer, and owner policy.
- [x] Convert Fusion available-models endpoint to exact route- and access-aware catalog metadata.
- [x] Add catalog, endpoint, Fusion, model-access, and provider regression tests.
- [x] Run focused catalog/self-api/Fusion/model-access/provider tests.
- [x] Run TypeScript build.
- [x] Run final full test suite and diff checks.
- [x] Create and verify signed local commit.
- [ ] Independent review (parent agent).
- [ ] Rebase/open PR (parent agent; intentionally not done in this task).

## Timeline

- 2026-07-15: Added the typed canonical registry in `src/providers/model-catalog.ts`; derived compatibility exports, provider pool sets, Gemini families, xAI image/video subsets, Groq audio, and Fusion chat eligibility from catalog metadata.
- 2026-07-15: Expanded authenticated `GET /v1/models` with raw callable IDs, unique provider-qualified `catalog_id`, route/API/modality/capability metadata, and request-policy filtering.
- 2026-07-15: Repair pass made interfaces authoritative for the flat primary fields; added complete OpenAI/xAI image, xAI video, Kimi, and Groq audio operation maps; split `direct_runtime_support` from exact existence and Fusion routability; and preserved Cerebras direct runtime models as exactly `gpt-oss-120b` plus `zai-glm-4.7`.
- 2026-07-15: Centralized actual Fusion provider routes, corrected xAI Fusion to Responses translation/extraction, rejected exact fake/unroutable models, and applied alias/underlying-model/owner policy to `/v1/models` and `/api/me/fusion-available-models`.
- 2026-07-15: Earlier repair verification passed focused catalog, self-API, Fusion, model-access, and provider tests (284/284); TypeScript build passed.
- 2026-07-15: Closed the final request/catalog parity gaps: Kimi, Groq, and Cerebras now authorize the resolved effective model before account selection, and both user-specific model catalog routes return `Cache-Control: private, no-store` for authenticated and rejected responses.
- 2026-07-15: Final metadata/access repair added explicit Gemini Live WebSocket + client-secret interfaces, Runpod rewrite metadata, catalog-derived OpenAI/xAI capability subsets, corrupt-preset resilience, and shared requested-alias/effective-runtime authorization. Verification passed focused affected suites (161/161), TypeScript build, full suite (616/616), and `git diff --check`.
