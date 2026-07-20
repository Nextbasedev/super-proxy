export type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'embedding';

export type ModelCapability =
  | 'chat'
  | 'messages'
  | 'embeddings'
  | 'text-to-speech'
  | 'speech-to-text'
  | 'speech-translation'
  | 'realtime'
  | 'image-generation'
  | 'image-editing'
  | 'video-generation'
  | 'reference-to-video'
  | 'video-editing'
  | 'video-extension'
  | 'fusion';

export type ModelResponseMode = 'streaming' | 'non_streaming';

export interface ModelInterface {
  operation: ModelCapability;
  method: 'GET' | 'POST';
  transport: 'http' | 'websocket';
  path: string;
  api: string;
  response_modes: readonly ModelResponseMode[];
  request_model?: string;
}

export interface ModelCatalogEntry {
  provider: KnownProvider;
  id: string;
  /** Backward-compatible primary interface path, derived from interfaces[0]. */
  endpoint: string;
  /** Backward-compatible primary interface API, derived from interfaces[0]. */
  api: string;
  /** Backward-compatible primary response mode, derived from interfaces[0]. */
  streaming: boolean;
  /** Backward-compatible primary response mode, derived from interfaces[0]. */
  non_streaming: boolean;
  input_modalities: readonly ModelModality[];
  output_modalities: readonly ModelModality[];
  capabilities: readonly ModelCapability[];
  interfaces: readonly ModelInterface[];
  /** Whether the requested ID is sent directly to the provider runtime. */
  direct_runtime_support: boolean;
  /** Runtime ID used when direct_runtime_support is false. */
  runtime_model?: string;
  max_reference_images?: number;
}

export const CATALOG_PROVIDERS = [
  'anthropic',
  'openai_codex',
  'openai',
  'fish',
  'groq',
  'cerebras',
  'kimi',
  'glm',
  'gemini',
  'openrouter',
  'deepgram',
  'runpod',
  'xai',
  'fusion',
] as const;

export type KnownProvider = (typeof CATALOG_PROVIDERS)[number];

type ModelDefinition = Omit<
  ModelCatalogEntry,
  'provider' | 'id' | 'endpoint' | 'api' | 'streaming' | 'non_streaming' | 'direct_runtime_support'
> & {
  direct_runtime_support?: boolean;
};
type ModelOverride = Partial<ModelDefinition> & { id: string };

const STREAMING_AND_NON_STREAMING = ['streaming', 'non_streaming'] as const;
const NON_STREAMING = ['non_streaming'] as const;
const STREAMING = ['streaming'] as const;

function iface(
  operation: ModelCapability,
  path: string,
  api: string,
  response_modes: readonly ModelResponseMode[],
  method: ModelInterface['method'] = 'POST',
  transport: ModelInterface['transport'] = 'http',
): ModelInterface {
  return { operation, method, transport, path, api, response_modes };
}

/**
 * Build catalog entries from interface-first definitions. The legacy flat
 * endpoint/api/streaming/non_streaming fields are always derived from the first
 * interface, so they cannot drift from the primary/default operation.
 */
function group(provider: KnownProvider, ids: readonly (string | ModelOverride)[], defaults: ModelDefinition): ModelCatalogEntry[] {
  return ids.map((model) => {
    const { id, ...override } = typeof model === 'string' ? { id: model } : model;
    const definition = { ...defaults, ...override };
    const primary = definition.interfaces[0];
    if (!primary) throw new Error(`Catalog model ${provider}/${id} must define at least one interface`);
    return {
      provider,
      id,
      ...definition,
      endpoint: primary.path,
      api: primary.api,
      streaming: primary.response_modes.includes('streaming'),
      non_streaming: primary.response_modes.includes('non_streaming'),
      direct_runtime_support: definition.direct_runtime_support ?? true,
    };
  });
}

const CHAT = {
  input_modalities: ['text'] as const,
  output_modalities: ['text'] as const,
  capabilities: ['chat'] as const,
};

/**
 * Canonical static NBMG model registry.
 *
 * Model existence, direct provider-runtime support, and Fusion routability are
 * deliberately distinct. This registry establishes existence and direct
 * runtime metadata. Fusion routability is derived from the actual dispatcher
 * route table in src/fusion/provider-routes.ts.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  ...group('anthropic', [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5',
  ], {
    ...CHAT,
    input_modalities: ['text', 'image'],
    interfaces: [iface('chat', '/v1/messages', 'anthropic-messages', STREAMING_AND_NON_STREAMING)],
  }),

  ...group('openai_codex', [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
  ], {
    ...CHAT,
    input_modalities: ['text', 'image'],
    interfaces: [iface('chat', '/v1/responses', 'openai-responses', STREAMING_AND_NON_STREAMING)],
  }),
  ...group('openai_codex', ['gpt-realtime-2', 'gpt-realtime'], {
    input_modalities: ['text', 'audio'],
    output_modalities: ['text', 'audio'],
    capabilities: ['realtime'],
    // NBMG returns a short-lived credential synchronously; the client then
    // opens its own upstream realtime connection.
    interfaces: [iface('realtime', '/v1/realtime/client_secrets', 'openai-realtime', NON_STREAMING)],
  }),
  ...group('openai_codex', ['gpt-image-2'], {
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
    capabilities: ['image-generation', 'image-editing'],
    interfaces: [
      iface('image-generation', '/v1/images/generations', 'openai-images', NON_STREAMING),
      iface('image-editing', '/v1/images/edits', 'openai-images', NON_STREAMING),
    ],
  }),
  ...group('openai', ['gpt-image-2'], {
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
    capabilities: ['image-generation', 'image-editing'],
    interfaces: [
      iface('image-generation', '/v1/images/generations', 'openai-images', NON_STREAMING),
      iface('image-editing', '/v1/images/edits', 'openai-images', NON_STREAMING),
    ],
  }),

  ...group('fish', ['s2.1-pro-free'], {
    input_modalities: ['text'],
    output_modalities: ['audio'],
    capabilities: ['text-to-speech'],
    interfaces: [iface('text-to-speech', '/v1/fish/tts', 'fish-tts', NON_STREAMING)],
  }),

  ...group('groq', [
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
    'deepseek-r1-distill-llama-70b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
  ], {
    ...CHAT,
    interfaces: [iface('chat', '/v1/groq/chat/completions', 'openai-chat-completions', STREAMING_AND_NON_STREAMING)],
  }),
  ...group('groq', ['whisper-large-v3', 'whisper-large-v3-turbo'], {
    input_modalities: ['audio'],
    output_modalities: ['text'],
    capabilities: ['speech-to-text', 'speech-translation'],
    interfaces: [
      iface('speech-to-text', '/v1/groq/audio/transcriptions', 'openai-audio', NON_STREAMING),
      iface('speech-translation', '/v1/groq/audio/translations', 'openai-audio', NON_STREAMING),
    ],
  }),

  ...group('cerebras', [
    { id: 'qwen-3-235b-a22b-instruct-2507', direct_runtime_support: false, runtime_model: 'gpt-oss-120b' },
    'gpt-oss-120b',
    'zai-glm-4.7',
    { id: 'llama3.1-8b', direct_runtime_support: false, runtime_model: 'gpt-oss-120b' },
  ], {
    ...CHAT,
    interfaces: [iface('chat', '/v1/cerebras/chat/completions', 'openai-chat-completions', STREAMING_AND_NON_STREAMING)],
  }),

  // Kimi Code documents `k3` as the exact upstream runtime ID for Kimi K3
  // (not `kimi-k3`). It uses the existing Kimi Code chat/messages surfaces.
  // Context entitlement is account-plan dependent: Moderato supports 256k;
  // Allegretto and above support up to 1M.
  ...group('kimi', ['k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-for-coding'], {
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    capabilities: ['chat', 'messages'],
    interfaces: [
      iface('chat', '/v1/kimi/chat/completions', 'openai-chat-completions', STREAMING_AND_NON_STREAMING),
      iface('messages', '/v1/kimi/messages', 'anthropic-messages', STREAMING_AND_NON_STREAMING),
    ],
  }),
  ...group('glm', ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.5'], {
    ...CHAT,
    interfaces: [iface('chat', '/v1/glm/messages', 'anthropic-messages', STREAMING_AND_NON_STREAMING)],
  }),

  ...group('gemini', ['gemini-embedding-001', 'gemini-embedding-2', 'gemini-embedding-2-preview'], {
    input_modalities: ['text'],
    output_modalities: ['embedding'],
    capabilities: ['embeddings'],
    interfaces: [iface('embeddings', '/v1/gemini/embeddings', 'gemini-embeddings', NON_STREAMING)],
  }),
  ...group('gemini', ['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview'], {
    input_modalities: ['text'],
    output_modalities: ['audio'],
    capabilities: ['text-to-speech'],
    interfaces: [iface('text-to-speech', '/v1/gemini/tts', 'gemini-tts', NON_STREAMING)],
  }),
  ...group('gemini', ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'], {
    ...CHAT,
    input_modalities: ['text', 'image', 'audio'],
    interfaces: [iface('chat', '/v1/gemini/chat/completions', 'openai-chat-completions', NON_STREAMING)],
  }),
  ...group('gemini', ['gemini-2.5-flash', 'gemini-3.5-flash'], {
    ...CHAT,
    input_modalities: ['text', 'image', 'audio', 'video'],
    interfaces: [iface('chat', '/v1/gemini/chat/completions', 'openai-chat-completions', NON_STREAMING)],
  }),
  ...group('gemini', [
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-2.5-flash-native-audio-preview-09-2025',
    'gemini-2.5-flash-native-audio-latest',
    'gemini-3.1-flash-live-preview',
    'gemini-3.5-live-translate-preview',
  ], {
    input_modalities: ['text', 'audio', 'image', 'video'],
    output_modalities: ['text', 'audio'],
    capabilities: ['realtime'],
    interfaces: [
      iface('realtime', '/v1/gemini/realtime', 'gemini-live', STREAMING, 'GET', 'websocket'),
      iface('realtime', '/v1/gemini/realtime/client_secrets', 'gemini-live', NON_STREAMING),
    ],
  }),

  ...group('openrouter', ['tencent/hy3:free'], {
    ...CHAT,
    input_modalities: ['text', 'image'],
    interfaces: [iface('chat', '/v1/openrouter/chat/completions', 'openai-chat-completions', STREAMING_AND_NON_STREAMING)],
  }),
  ...group('deepgram', ['nova-3', 'nova-3-general', 'nova-2', 'nova-2-general', 'nova', 'base', 'enhanced', 'whisper'], {
    input_modalities: ['audio'],
    output_modalities: ['text'],
    capabilities: ['speech-to-text'],
    interfaces: [iface('speech-to-text', '/v1/deepgram/listen', 'deepgram-listen', NON_STREAMING)],
  }),
  ...group('runpod', [
    'qwen36-27b',
    { id: 'qwen36-27b-fast', direct_runtime_support: false, runtime_model: 'qwen36-27b' },
  ], {
    ...CHAT,
    interfaces: [iface('chat', '/v1/runpod/chat/completions', 'openai-chat-completions', STREAMING_AND_NON_STREAMING)],
  }),

  ...group('xai', [
    'grok-4.5', 'grok-4.3', 'grok-4', 'grok-4-0709', 'grok-4-fast', 'grok-4-fast-non-reasoning',
    'grok-4-1-fast', 'grok-4-1-fast-non-reasoning', 'grok-4.20-beta-latest-reasoning',
    'grok-4.20-beta-latest-non-reasoning', 'grok-code-fast-1', 'composer-2.5',
    'grok-composer-2.5-fast', 'grok-3', 'grok-3-fast', 'grok-3-mini', 'grok-3-mini-fast',
    'grok-4-fast-reasoning', 'grok-4-1-fast-reasoning', 'grok-4.20-reasoning', 'grok-4.20-non-reasoning',
  ], {
    ...CHAT,
    input_modalities: ['text', 'image'],
    interfaces: [iface('chat', '/v1/xai/responses', 'openai-responses', STREAMING_AND_NON_STREAMING)],
  }),
  ...group('xai', ['grok-voice-think-fast-1.0', 'grok-voice-latest', 'grok-realtime-voice'], {
    input_modalities: ['text', 'audio'],
    output_modalities: ['text', 'audio'],
    capabilities: ['realtime'],
    // This gateway route mints a credential synchronously; it is not the
    // client-to-xAI realtime WebSocket itself.
    interfaces: [iface('realtime', '/v1/xai/realtime/client_secrets', 'xai-realtime', NON_STREAMING)],
  }),
  ...group('xai', ['grok-voice-tts'], {
    input_modalities: ['text'],
    output_modalities: ['audio'],
    capabilities: ['text-to-speech'],
    interfaces: [iface('text-to-speech', '/v1/xai/tts', 'xai-tts', NON_STREAMING)],
  }),
  ...group('xai', ['grok-stt'], {
    input_modalities: ['audio'],
    output_modalities: ['text'],
    capabilities: ['speech-to-text'],
    interfaces: [iface('speech-to-text', '/v1/xai/stt', 'xai-stt', NON_STREAMING)],
  }),
  ...group('xai', ['grok-imagine-image', 'grok-imagine-image-quality'], {
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
    capabilities: ['image-generation', 'image-editing'],
    max_reference_images: 3,
    interfaces: [
      iface('image-generation', '/v1/xai/images/generations', 'xai-images', NON_STREAMING),
      iface('image-editing', '/v1/xai/images/edits', 'xai-images', NON_STREAMING),
    ],
  }),
  ...group('xai', [
    {
      id: 'grok-imagine-video',
      capabilities: ['video-generation', 'reference-to-video', 'video-editing', 'video-extension'],
      max_reference_images: 7,
      interfaces: [
        iface('video-generation', '/v1/xai/videos/generations', 'xai-videos', NON_STREAMING),
        iface('reference-to-video', '/v1/xai/videos/generations', 'xai-videos', NON_STREAMING),
        iface('video-editing', '/v1/xai/videos/edits', 'xai-videos', NON_STREAMING),
        iface('video-extension', '/v1/xai/videos/extensions', 'xai-videos', NON_STREAMING),
      ],
    },
    'grok-imagine-video-1.5-preview',
  ], {
    input_modalities: ['text', 'image', 'video'],
    output_modalities: ['video'],
    capabilities: ['video-generation'],
    interfaces: [iface('video-generation', '/v1/xai/videos/generations', 'xai-videos', NON_STREAMING)],
  }),

  ...group('fusion', ['max', 'quality', 'budget', 'custom'], {
    input_modalities: ['text'],
    output_modalities: ['text'],
    capabilities: ['fusion'],
    interfaces: [iface('fusion', '/v1/fusion/chat/completions', 'fusion', STREAMING_AND_NON_STREAMING)],
  }),
];

export const KNOWN_MODELS_BY_PROVIDER: Record<KnownProvider, readonly string[]> = Object.fromEntries(
  CATALOG_PROVIDERS.map((provider) => [provider, MODEL_CATALOG.filter((entry) => entry.provider === provider).map((entry) => entry.id)]),
) as unknown as Record<KnownProvider, readonly string[]>;

export const KNOWN_PROVIDERS = CATALOG_PROVIDERS;

export function isKnownProvider(provider: string): provider is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(provider);
}

export function findCatalogModel(provider: string, model: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.provider === provider && entry.id === model);
}

export function isKnownModel(provider: string, model: string): boolean {
  return findCatalogModel(provider, model) != null;
}

export function catalogModelsForProvider(provider: KnownProvider): readonly ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => entry.provider === provider);
}

export function catalogModelsWithCapability(provider: KnownProvider, capability: ModelCapability): readonly ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => entry.provider === provider && entry.capabilities.includes(capability));
}

export function catalogModelIdsWithCapability(provider: KnownProvider, capability: ModelCapability): string[] {
  return catalogModelsWithCapability(provider, capability).map((entry) => entry.id);
}

export function catalogDirectRuntimeModelIdsWithCapability(provider: KnownProvider, capability: ModelCapability): string[] {
  return catalogModelsWithCapability(provider, capability)
    .filter((entry) => entry.direct_runtime_support)
    .map((entry) => entry.id);
}

export function catalogModelIdsByApi(provider: KnownProvider, api: string): string[] {
  return MODEL_CATALOG.filter((entry) => entry.provider === provider && entry.api === api).map((entry) => entry.id);
}

/**
 * Fixed `created` epoch for catalog listings. Catalog entries have no real
 * creation timestamp, but the OpenAI list schema requires one; a stable value
 * (2024-06-19, inherited from the original fusion-only /v1/models handler)
 * keeps client-side caching/diffing deterministic.
 */
export const CATALOG_LISTING_CREATED_TS = 1718789000;

/**
 * Serialize a catalog entry into the OpenAI-compatible model-listing shape
 * shared by GET /v1/models (self-api.ts) and GET /v1/<provider>/models
 * (api/provider-models.ts). Single source of truth so the two listings can
 * never drift — root-listing-only extras (e.g. fusion_routable) are passed
 * via `extra`.
 */
export function catalogEntryToListing(
  entry: ModelCatalogEntry,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: entry.id,
    catalog_id: `${entry.provider}/${entry.id}`,
    object: 'model',
    created: CATALOG_LISTING_CREATED_TS,
    owned_by: entry.provider,
    provider: entry.provider,
    endpoint: entry.endpoint,
    api: entry.api,
    streaming: entry.streaming,
    non_streaming: entry.non_streaming,
    input_modalities: entry.input_modalities,
    output_modalities: entry.output_modalities,
    capabilities: entry.capabilities,
    interfaces: entry.interfaces,
    direct_runtime_support: entry.direct_runtime_support,
    ...(entry.runtime_model == null ? {} : { runtime_model: entry.runtime_model }),
    ...(entry.max_reference_images == null ? {} : { max_reference_images: entry.max_reference_images }),
    ...extra,
  };
}
