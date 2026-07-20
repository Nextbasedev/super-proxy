/**
 * Per-provider OpenAI-compatible model listings: GET /v1/<provider>/models.
 *
 * Why: OpenAI-compat clients configured with a path-scoped base_url (e.g.
 * Hermes Agent with `base_url=.../v1/groq`) validate model switches by
 * probing `<base_url>/models` (with an add/strip-`/v1` fallback). #150 gave
 * the root `GET /v1/models` a full catalog, but the per-provider paths still
 * 404 — so those clients warn "model not found" on every switch.
 *
 * Everything derives from the canonical MODEL_CATALOG registry (#150):
 * providers, model ids, and metadata. No hardcoded provider/model lists —
 * adding a model to the registry updates these listings automatically.
 * Filtering uses the same authorizeEffectiveModelForUser policy as
 * request-time proxy enforcement.
 *
 * Route ownership: this module is the ONLY registrant of
 * GET /v1/<provider>/models. registerRunpodProxy's hardcoded, unfiltered
 * listing was removed in this change (a second registration of the same
 * route throws FST_ERR_DUPLICATED_ROUTE at startup and the server never
 * boots). The runpod entries here are equivalent (both virtual ids live in
 * the registry) plus per-user policy filtering.
 *
 * Fusion is intentionally NOT served here: fusion aliases and user presets
 * have visibility semantics beyond per-model policy (panel/synthesizer
 * viability — see isFusionPresetVisible in self-api.ts) and remain on the
 * root /v1/models listing only, under their `fusion/<alias>` ids.
 */
import type { FastifyInstance } from 'fastify';
import { requireProxyToken } from '../auth/token-auth.js';
import {
  CATALOG_PROVIDERS,
  catalogEntryToListing,
  catalogModelsForProvider,
  type KnownProvider,
} from '../providers/model-catalog.js';
import { authorizeEffectiveModelForUser } from '../proxy/policy.js';

/**
 * Providers whose proxy routes live under /v1/<provider>/... — derived from
 * the registry's own interface paths so this list cannot drift from reality:
 * a provider is path-scoped iff every one of its catalog interfaces is rooted
 * at /v1/<provider>/. (anthropic/openai_codex/openai are rooted at /v1
 * directly; fusion is excluded above.)
 */
export function pathScopedProviders(): KnownProvider[] {
  return CATALOG_PROVIDERS.filter((provider) => {
    if (provider === 'fusion') return false;
    const entries = catalogModelsForProvider(provider);
    if (!entries.length) return false;
    const prefix = `/v1/${provider}/`;
    return entries.every((entry) =>
      entry.interfaces.every((iface) => iface.path.startsWith(prefix)),
    );
  });
}

export function registerProviderModelsRoutes(app: FastifyInstance) {
  for (const provider of pathScopedProviders()) {
    app.get(`/v1/${provider}/models`, async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      const auth = await requireProxyToken(req, reply);
      if (!auth) return;

      // Shared serializer with root /v1/models (catalogEntryToListing) —
      // per-provider listings omit fusion_routable (a root-listing concern:
      // clients here pick models to call on THIS provider's endpoint).
      const data = catalogModelsForProvider(provider)
        .filter((entry) => authorizeEffectiveModelForUser(auth.user, entry.provider, entry.id).ok)
        .map((entry) => catalogEntryToListing(entry));

      return { object: 'list', data };
    });
  }
}
